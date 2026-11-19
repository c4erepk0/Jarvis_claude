// Мост «приложение внутри Atom ↔ Atom» (postMessage) — без DOM, тест — tests/js/app-bridge.test.mjs.
// Встроенному приложению (iframe) браузер мешает скачивать файлы и вызывать «Поделиться» (особенно Safari на iPhone),
// а его данные живут только на одном устройстве. Через мост приложение:
//   → «hello»      — сообщает, что умеет говорить с Atom; Atom отвечает «welcome» и общими данными;
//   → «store:set»  — отдаёт свои данные: Atom хранит их (appdata.py) и рассылает остальным (владелец, операторы);
//   → «download»   — отдаёт готовый файл: Atom показывает своё окно «Файл готов» (поделиться, скачать, открыть);
//   ← «store»      — свежие данные, которые сохранил кто-то другой.
// Сообщение принимается, только если пришло из окна этого приложения и с его адреса (origin).
export const PROTOCOL = "atom-app/1";
export const FROM_APP = new Set(["hello", "store:set", "download"]);
export const MAX_FILE = 60 * 2 ** 20;
const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml",
  zip: "application/zip", json: "application/json", txt: "text/plain", csv: "text/csv" };

/** Сообщение от встроенного приложения или null (чужое окно, чужой адрес, не наш формат). */
export function fromApp(event, frameWindow, origin) {
  if (!event || !frameWindow || event.source !== frameWindow || event.origin !== origin) return null;
  const m = event.data;
  if (!m || typeof m !== "object" || m.protocol !== PROTOCOL || !FROM_APP.has(m.atom)) return null;
  return m;
}

/** Сообщение для приложения. */
export const toApp = (atom, extra = {}) => ({ protocol: PROTOCOL, atom, ...extra });

/** Безопасное имя файла: без путей и служебных символов, с расширением. */
export function safeFileName(name, fallback = "файл") {
  const s = String(name || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]+/g, " ").replace(/\s+/g, " ").trim();
  return (s && s !== "." && s !== ".." ? s : fallback).slice(0, 120);
}

/** Из сообщения «download» — { name, type, size, blob } или ошибка с понятным текстом. */
export function fileFromMessage(m) {
  const name = safeFileName(m.name);
  const ext = (name.split(".").pop() || "").toLowerCase();
  const type = typeof m.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(m.type) ? m.type : MIME[ext] || "application/octet-stream";
  let blob;
  if (m.data instanceof Blob) blob = m.data.type ? m.data : new Blob([m.data], { type });
  else if (m.data instanceof ArrayBuffer || ArrayBuffer.isView(m.data)) blob = new Blob([m.data], { type });
  else if (typeof m.data === "string") blob = new Blob([m.data], { type });
  else throw new Error("в сообщении нет файла");
  if (!blob.size) throw new Error("файл пустой");
  if (blob.size > MAX_FILE) throw new Error("файл больше 60 МБ");
  return { name, type: blob.type || type, size: blob.size, blob };
}

/** «1,4 МБ», «820 КБ». */
export function fileSize(bytes) {
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1).replace(".", ",")} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Встраивать можно https, а для разработки — http на этом компьютере. */
export function embeddableUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch { return false; }
}
