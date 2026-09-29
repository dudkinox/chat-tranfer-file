import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

test('LAN messages, live events, multiple attachments, download, and persistence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lan-drop-test-'));
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.js'], { env: {...process.env, PORT:'0', DATA_DIR:dir}, stdio:['ignore','pipe','pipe'] });
    return await new Promise((resolve,reject) => { child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/localhost:(\d+)/); if(match) resolve(`http://127.0.0.1:${match[1]}`); }); child.on('error',reject); child.on('exit',code => reject(new Error(`Server exited ${code}`))); });
  }
  async function stop() { child.kill(); await once(child,'exit'); }
  try {
    let base = await start();
    const abort = new AbortController();
    const response = await fetch(`${base}/api/events`, {signal:abort.signal});
    const reader = response.body.getReader();
    let events = new TextDecoder().decode((await reader.read()).value);
    assert.match(events,/event: history/);
    assert.equal((await (await fetch(`${base}/api/info`)).json()).maxFileSize, null);
    // Stream past the former 100 MB boundary without allocating the whole file.
    const expectedHash = createHash('sha256');
    async function* largeBody() {
      const chunk = Buffer.alloc(1024 * 1024, 97);
      for (let i = 0; i < 101; i++) { expectedHash.update(chunk); yield chunk; }
    }
    const largeUpload = await fetch(`${base}/api/upload?name=large.bin`, {
      method:'POST', body:largeBody(), duplex:'half',
    });
    assert.equal(largeUpload.status,201);
    const largeFile = await largeUpload.json();
    assert.equal(largeFile.size,101 * 1024 * 1024);
    const largeMessage = await (await fetch(`${base}/api/messages`, {
      method:'POST', body:JSON.stringify({files:[largeFile.id]}),
    })).json();
    const largeDownload = await fetch(`${base}/files/${largeFile.id}`);
    assert.equal(Number(largeDownload.headers.get('content-length')),largeFile.size);
    const receivedHash = createHash('sha256');
    for await (const chunk of largeDownload.body) receivedHash.update(chunk);
    assert.equal(receivedHash.digest('hex'),expectedHash.digest('hex'));
    assert.equal((await fetch(`${base}/api/messages/${largeMessage.id}`,{method:'DELETE'})).status,200);
    const attachments = [];
    for (const [name, content] of [['hello.txt','LAN test'],['ชื่อไทย.txt','ทดสอบ']]) {
      const res = await fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, {method:'POST',headers:{'Content-Type':'text/plain'},body:content});
      assert.equal(res.status,201); attachments.push(await res.json());
    }
    const sent = await fetch(`${base}/api/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'hello <script>',sender:'test',files:attachments.map(f=>f.id)})});
    assert.equal(sent.status,201);
    const message = await sent.json(); assert.equal(message.files.length,2);
    while (!events.includes(message.id)) events += new TextDecoder().decode((await reader.read()).value);
    assert.ok(events.includes(message.id));
    const download = await fetch(`${base}/files/${attachments[1].id}`);
    assert.equal(await download.text(),'ทดสอบ'); assert.match(download.headers.get('content-disposition'),/attachment/);
    assert.equal((await fetch(`${base}/api/messages`,{method:'POST',body:JSON.stringify({files:['missing']})})).status,400);
    assert.equal((await fetch(`${base}/api/messages`,{method:'POST',headers:{Origin:'http://evil.test'},body:'{}'})).status,403);
    abort.abort(); await stop(); base = await start();
    const abort2 = new AbortController();
    const restored = await fetch(`${base}/api/events`,{signal:abort2.signal});
    const history = new TextDecoder().decode((await restored.body.getReader().read()).value);
    assert.ok(history.includes(message.id)); abort2.abort();
    assert.equal(await (await fetch(`${base}/files/${attachments[0].id}`)).text(),'LAN test');
    assert.equal((await fetch(base)).status,200);
    const deleteAbort = new AbortController();
    const live = await fetch(`${base}/api/events`, {signal:deleteAbort.signal});
    const liveReader = live.body.getReader();
    await liveReader.read();
    const extra = await (await fetch(`${base}/api/messages`, {method:'POST',body:JSON.stringify({text:'keep me'})})).json();
    assert.equal((await fetch(`${base}/api/messages`, {method:'DELETE',headers:{Origin:'http://evil.test'}})).status,403);
    const deleted = await fetch(`${base}/api/messages/${message.id}`, {method:'DELETE'});
    assert.deepEqual((await deleted.json()).ids,[message.id]);
    let deletionEvents = '';
    while (!deletionEvents.includes('event: deleted')) deletionEvents += new TextDecoder().decode((await liveReader.read()).value);
    assert.ok(deletionEvents.includes(message.id));
    for (const file of attachments) {
      assert.equal((await fetch(`${base}/files/${file.id}`)).status,404);
      await assert.rejects(access(path.join(dir,'files',file.id)), {code:'ENOENT'});
    }
    assert.equal((await fetch(`${base}/api/messages/${message.id}`, {method:'DELETE'})).status,404);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir,'messages.json'),'utf8')).map(m=>m.id),[extra.id]);
    const file = await (await fetch(`${base}/api/upload?name=delete-all.txt`, {method:'POST',body:'remove me'})).json();
    const attached = await (await fetch(`${base}/api/messages`, {method:'POST',body:JSON.stringify({files:[file.id]})})).json();
    const cleared = await (await fetch(`${base}/api/messages`, {method:'DELETE'})).json();
    assert.deepEqual(cleared.ids,[extra.id,attached.id]);
    let clearEvents = '';
    while (!clearEvents.includes(attached.id) || !clearEvents.includes('event: deleted')) clearEvents += new TextDecoder().decode((await liveReader.read()).value);
    await assert.rejects(access(path.join(dir,'files',file.id)), {code:'ENOENT'});
    assert.equal((await fetch(`${base}/files/${file.id}`)).status,404);
    assert.deepEqual((await (await fetch(`${base}/api/messages`,{method:'DELETE'})).json()).ids,[]);
    deleteAbort.abort();
    await stop(); base = await start();
    const finalAbort = new AbortController();
    const finalHistory = await fetch(`${base}/api/events`,{signal:finalAbort.signal});
    assert.match(new TextDecoder().decode((await finalHistory.body.getReader().read()).value),/event: history\ndata: \[\]/);
    finalAbort.abort();

  } finally { if(child?.exitCode === null) await stop(); await rm(dir,{recursive:true,force:true}); }
});
