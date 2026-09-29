const $ = (id) => document.getElementById(id);
const clientId =
  localStorage.getItem("lan-client") ||
  crypto.randomUUID?.() ||
  Math.random().toString(36).slice(2);
localStorage.setItem("lan-client", clientId);
$("sender").value =
  localStorage.getItem("lan-name") ||
  (/Mobi|Android/i.test(navigator.userAgent)
    ? "โทรศัพท์ของฉัน"
    : "คอมพิวเตอร์ของฉัน");
$("sender").addEventListener("change", () =>
  localStorage.setItem("lan-name", $("sender").value),
);
let selected = [],
  busy = false,
  messages = [],
  addresses = [],
  toastTimer;
const raster = (type) =>
  ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(
    type,
  );
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3200);
}
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function size(n) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = n > 0 ? Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1) : 0;
  return `${index === 0 ? n : (n / 1024 ** index).toFixed(1)} ${units[index]}`;
}

async function copy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext)
      await navigator.clipboard.writeText(text);
    else {
      const field = el("textarea");
      field.value = text;
      field.style.position = "fixed";
      field.style.opacity = "0";
      const host = $("share-dialog").open ? $("share-dialog") : document.body;
      host.append(field);
      field.select();
      const ok = document.execCommand("copy");
      field.remove();
      if (!ok) throw new Error();
    }
    toast("คัดลอกแล้ว");
  } catch {
    toast("คัดลอกไม่ได้ กรุณาเลือกข้อความแล้วคัดลอกด้วยตนเอง");
  }
}
function renderMessage(message) {
  const card = el("article", "message");
  card.dataset.id = message.id;
  const head = el("div", "message-head");
  head.append(
    el("span", "avatar", message.sender.slice(0, 1).toUpperCase()),
    el("strong", "", message.sender),
  );
  if (message.clientId === clientId) head.append(el("span", "you", "คุณ"));
  const time = el(
    "time",
    "",
    new Date(message.createdAt).toLocaleString("th-TH", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );
  time.dateTime = message.createdAt;
  head.append(time);
  const remove = el("button", "delete-btn", "ลบ");
  remove.type = "button";
  remove.setAttribute("aria-label", "ลบข้อความและไฟล์แนบ");
  remove.onclick = () => deleteMessages(message.id, remove);
  head.append(remove);
  card.append(head);
  if (message.text) {
    card.append(el("p", "message-text", message.text));
    const button = el("button", "copy-btn", "⧉  คัดลอกข้อความ");
    button.onclick = () => copy(message.text);
    card.append(button);
  }
  if (message.files.length) {
    const grid = el("div", "file-grid");
    for (const file of message.files) {
      const item = el("div", "file");
      if (raster(file.type)) {
        const link = el("a");
        link.href = `/files/${file.id}?preview`;
        link.target = "_blank";
        link.rel = "noopener";
        const img = el("img");
        img.src = link.href;
        img.alt = file.name;
        img.loading = "lazy";
        link.append(img);
        item.append(link);
      }
      const info = el("div", "file-info");
      info.append(el("span", "file-icon", raster(file.type) ? "▧" : "▤"));
      const detail = el("div", "file-details");
      const name = el("div", "file-name", file.name);
      name.title = file.name;
      detail.append(name, el("div", "file-size", size(file.size)));
      info.append(detail);
      const download = el("a", "download", "↓");
      download.href = `/files/${file.id}`;
      download.download = file.name;
      download.title = `ดาวน์โหลด ${file.name}`;
      download.setAttribute("aria-label", download.title);
      info.append(download);
      item.append(info);
      grid.append(item);
    }
    card.append(grid);
  }
  return card;
}
function updateCount() {
  $("count").textContent = messages.length;
  $("empty").hidden = messages.length > 0;
  $("delete-all").disabled = messages.length === 0;
}
function removeMessages(ids) {
  const removed = new Set(ids);
  messages = messages.filter(message => !removed.has(message.id));
  for (const card of Array.from($("feed").children)) {
    if (removed.has(card.dataset.id)) card.remove();
  }
  updateCount();
}
async function deleteMessages(id, button) {
  const question = id
    ? "ลบข้อความนี้พร้อมไฟล์แนบจากทุกอุปกรณ์? การลบนี้กู้คืนไม่ได้"
    : "ลบข้อความทั้งหมดพร้อมไฟล์แนบจากทุกอุปกรณ์? การลบนี้กู้คืนไม่ได้";
  if (!window.confirm(question)) return;
  button.disabled = true;
  try {
    const response = await fetch(id ? `/api/messages/${encodeURIComponent(id)}` : "/api/messages", { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "ลบไม่สำเร็จ");
    removeMessages(result.ids);
    toast(id ? "ลบข้อความแล้ว" : "ลบข้อความทั้งหมดแล้ว");
  } catch (error) {
    toast(error.message || "ลบไม่สำเร็จ กรุณาลองอีกครั้ง");
  } finally {
    button.disabled = false;
    updateCount();
  }
}
$("delete-all").onclick = () => deleteMessages(null, $("delete-all"));
const stream = new EventSource("/api/events");
stream.onopen = () => {
  $("connection").textContent = "เชื่อมต่อแล้ว";
  $("connection").classList.add("connected");
};
stream.onerror = () => {
  $("connection").textContent = "กำลังเชื่อมต่อใหม่…";
  $("connection").classList.remove("connected");
};
stream.addEventListener("history", (e) => {
  messages = JSON.parse(e.data);
  $("feed").replaceChildren(...messages.map(renderMessage));
  updateCount();
});
stream.addEventListener("message", (e) => {
  const message = JSON.parse(e.data);
  if (messages.some((m) => m.id === message.id)) return;
  messages.push(message);
  $("feed").append(renderMessage(message));
  updateCount();
  if (message.clientId === clientId)
    $("composer").scrollIntoView({ behavior: "smooth", block: "end" });
});
stream.addEventListener("presence", (e) => {
  $("online").textContent = `${e.data} การเชื่อมต่อ · อัปเดตแบบเรียลไทม์`;
});
stream.addEventListener("deleted", e => removeMessages(JSON.parse(e.data).ids));
function renderAttachments() {
  $("attachments").replaceChildren();
  selected.forEach((item, index) => {
    const chip = el("div", "attachment");
    if (item.preview) {
      const img = el("img");
      img.src = item.preview;
      img.alt = "";
      chip.append(img);
    }
    chip.append(el("span", "", item.file.name));
    const remove = el("button", "", "×");
    remove.type = "button";
    remove.disabled = busy;
    remove.setAttribute("aria-label", `ลบ ${item.file.name}`);
    remove.onclick = () => {
      URL.revokeObjectURL(item.preview);
      selected.splice(index, 1);
      renderAttachments();
    };
    chip.append(remove);
    $("attachments").append(chip);
  });
}
function addFiles(files) {
  if (busy) return;
  for (const file of files) {
    if (selected.length >= 30) {
      toast("แนบได้สูงสุด 30 ไฟล์ต่อข้อความ");
      break;
    }
    selected.push({
      file,
      preview: raster(file.type) ? URL.createObjectURL(file) : null,
    });
  }
  renderAttachments();
}
$("attach").onclick = () => $("file-input").click();
$("file-input").onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = "";
};
document.addEventListener("paste", (e) => {
  const files = Array.from(e.clipboardData?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (e.dataTransfer.types.includes("Files")) {
    e.preventDefault();
    dragDepth++;
    $("drop-overlay").classList.add("visible");
  }
});
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("drop-overlay").classList.remove("visible");
  }
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-overlay").classList.remove("visible");
  addFiles(e.dataTransfer.files);
});
$("text").onkeydown = (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
};
function upload(item, index, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?name=${encodeURIComponent(item.file.name)}`);
    xhr.setRequestHeader(
      "Content-Type",
      item.file.type || "application/octet-stream",
    );
    xhr.upload.onprogress = (e) => {
      $("progress").textContent =
        `กำลังอัปโหลด ${index + 1}/${total} · ${item.file.name} · ${e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : 0}%`;
    };
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status >= 400) throw new Error(result.error);
        resolve(result);
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new Error("เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง"));
    xhr.send(item.file);
  });
}
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  if (busy) return;
  const text = $("text").value.trim();
  if (!text && !selected.length) {
    $("text").focus();
    return;
  }
  busy = true;
  $("send").disabled = true;
  $("attach").disabled = true;
  $("text").disabled = true;
  renderAttachments();
  try {
    const files = [];
    for (let i = 0; i < selected.length; i++) {
      const item = selected[i];
      if (!item.uploaded)
        item.uploaded = await upload(item, i, selected.length);
      files.push(item.uploaded.id);
    }
    $("progress").textContent = "กำลังส่งข้อความ…";
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        files,
        sender: $("sender").value,
        clientId,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      selected.forEach((item) => delete item.uploaded);
      throw new Error(result.error);
    }
    selected.forEach((item) => URL.revokeObjectURL(item.preview));
    selected = [];
    $("text").value = "";
    toast("ส่งเรียบร้อยแล้ว");
  } catch (error) {
    toast(error.message || "ส่งไม่สำเร็จ กรุณาลองอีกครั้ง");
  } finally {
    busy = false;
    $("send").disabled = false;
    $("attach").disabled = false;
    $("text").disabled = false;
    $("progress").textContent = "";
    renderAttachments();
    $("text").focus();
  }
};
fetch("/api/info")
  .then((r) => r.json())
  .then((info) => {
    addresses = info.addresses.length ? info.addresses : [location.origin];
    $("address").replaceChildren(
      document.createTextNode(addresses[0]),
      el("span", "", "⧉"),
    );
    for (const address of addresses) {
      const button = el("button", "", `${address}  ⧉`);
      button.onclick = () => copy(address);
      $("links").append(button);
    }
  })
  .catch(() => {
    $("address").textContent = location.origin;
    addresses = [location.origin];
  });
$("address").onclick = () => copy(addresses[0] || location.origin);
$("share").onclick = () => $("share-dialog").showModal();
$("close-dialog").onclick = () => $("share-dialog").close();
