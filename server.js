import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
await mkdir(path.join(data, 'files'), { recursive: true });
let messages = [];
try { messages = JSON.parse(await readFile(path.join(data, 'messages.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const pending = new Map();
const clients = new Set();
let saveQueue = Promise.resolve();
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function broadcast(event, value) { for (const client of clients) client.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); }
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 100000) throw new Error('ข้อความมีขนาดใหญ่เกินไป'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
const server = http.createServer({ requestTimeout: 0 }, async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (['POST', 'DELETE'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Origin not allowed' });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: history\ndata: ${JSON.stringify(messages)}\n\n`);
      clients.add(res); broadcast('presence', clients.size);
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 20000);
      req.on('close', () => { clearInterval(timer); clients.delete(res); broadcast('presence', clients.size); }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/info') {
      const port = server.address().port;
      const addresses = Object.values(networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${port}`);
      return json(res, 200, { addresses, maxFileSize: null });
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const name = (url.searchParams.get('name') || 'file').slice(0, 255);
      const id = randomUUID(); const dest = path.join(data, 'files', id);
      let size = 0;
      const counter = new Transform({ transform(chunk, encoding, cb) { size += chunk.length; cb(null, chunk); } });
      try { await pipeline(req, counter, createWriteStream(dest)); }
      catch (e) { await unlink(dest).catch(() => {}); throw e; }
      const type = (req.headers['content-type'] || 'application/octet-stream').split(';')[0];
      const file = { id, name, size, type };
      pending.set(id, { file, created: Date.now() });
      return json(res, 201, file);
    }
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      const input = await body(req);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      const ids = input.files ?? [];
      if (text.length > 20000 || !Array.isArray(ids) || ids.length > 30 || new Set(ids).size !== ids.length || ids.some(id => !pending.has(id)) || (!text && !ids.length)) return json(res, 400, { error: 'ข้อความหรือไฟล์ไม่ถูกต้อง (สูงสุด 30 ไฟล์)' });
      const message = { id: randomUUID(), text, files: ids.map(id => pending.get(id).file), sender: String(input.sender || 'อุปกรณ์').slice(0, 40), clientId: String(input.clientId || '').slice(0, 100), createdAt: new Date().toISOString() };
      ids.forEach(id => pending.delete(id));
      const operation = saveQueue.then(async () => {
        const next = [...messages, message];
        await writeFile(path.join(data, 'messages.tmp'), JSON.stringify(next));
        await rename(path.join(data, 'messages.tmp'), path.join(data, 'messages.json'));
        messages = next; broadcast('message', message);
      });
      saveQueue = operation.catch(() => {});
      try { await operation; } catch (e) { message.files.forEach(file => pending.set(file.id, { file, created: Date.now() })); throw e; }
      return json(res, 201, message);
    }
    if (req.method === 'DELETE' && (url.pathname === '/api/messages' || /^\/api\/messages\/[^/]+$/.test(url.pathname))) {
      const id = url.pathname === '/api/messages' ? null : url.pathname.slice('/api/messages/'.length);
      const operation = saveQueue.then(async () => {
        const removed = messages.filter(message => id === null || message.id === id);
        if (id !== null && !removed.length) return null;
        const next = id === null ? [] : messages.filter(message => message.id !== id);
        await writeFile(path.join(data, 'messages.tmp'), JSON.stringify(next));
        await rename(path.join(data, 'messages.tmp'), path.join(data, 'messages.json'));
        messages = next;
        const ids = removed.map(message => message.id);
        broadcast('deleted', { ids });
        await Promise.all(removed.flatMap(message => message.files).map(file => unlink(path.join(data, 'files', file.id)).catch(error => {
          if (error.code !== 'ENOENT') console.error(`Cannot remove attachment ${file.id}: ${error.message}`);
        })));
        return ids;
      });
      saveQueue = operation.catch(() => {});
      const ids = await operation;
      return ids === null ? json(res, 404, { error: 'ข้อความนี้ถูกลบแล้ว' }) : json(res, 200, { ids });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const id = url.pathname.slice(7);
      const file = messages.flatMap(m => m.files).find(f => f.id === id);
      if (!file) return json(res, 404, { error: 'ไม่พบไฟล์' });
      const preview = url.searchParams.has('preview') && ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(file.type);
      res.writeHead(200, { 'Content-Type': preview ? file.type : 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}` });
      createReadStream(path.join(data, 'files', id)).on('error', () => res.destroy()).pipe(res); return;
    }
    const assets = { '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'], '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
    if (req.method === 'GET' && assets[url.pathname]) {
      const [name, type] = assets[url.pathname];
      const content = await readFile(path.join(root, 'public', name));
      res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'" }); res.end(content); return;
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) { console.error(error.message); if (!res.headersSent) json(res, 400, { error: error.message }); else res.destroy(); }
});
setInterval(() => { for (const [id, item] of pending) if (Date.now() - item.created > 3600000) { pending.delete(id); unlink(path.join(data, 'files', id)).catch(() => {}); } }, 60000).unref();
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log(`LAN Drop ready: http://localhost:${server.address().port}`);
  for (const i of Object.values(networkInterfaces()).flat()) if (i.family === 'IPv4' && !i.internal) console.log(`Open on other devices: http://${i.address}:${server.address().port}`);
});
