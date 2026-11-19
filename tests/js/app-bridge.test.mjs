// Мост «приложение внутри Atom ↔ Atom»: только своё окно и свой адрес, файлы, имена, размеры (app-bridge.js).
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_FILE, PROTOCOL, embeddableUrl, fileFromMessage, fileSize, fromApp, safeFileName, toApp }
  from "../../jarvis/webapp/static/app-bridge.js";

const frame = {}, other = {}, ORIGIN = "https://c4erepk0.github.io";
const ev = (data, source = frame, origin = ORIGIN) => ({ data, source, origin });

test("сообщение принимается только от своего приложения", () => {
  const hello = { protocol: PROTOCOL, atom: "hello" };
  assert.equal(fromApp(ev(hello), frame, ORIGIN), hello);
  assert.equal(fromApp(ev(hello, other), frame, ORIGIN), null);                     // другое окно
  assert.equal(fromApp(ev(hello, frame, "https://evil.example"), frame, ORIGIN), null);   // другой адрес
  assert.equal(fromApp(ev({ protocol: "x", atom: "hello" }), frame, ORIGIN), null);
  assert.equal(fromApp(ev({ protocol: PROTOCOL, atom: "rm -rf" }), frame, ORIGIN), null);
  assert.equal(fromApp(ev("строка"), frame, ORIGIN), null);
  assert.equal(fromApp(ev(hello), null, ORIGIN), null);
  assert.deepEqual(toApp("store", { rev: 2 }), { protocol: PROTOCOL, atom: "store", rev: 2 });
});

test("файл из сообщения: тип по расширению, пустой и огромный — ошибка", async () => {
  const f = fileFromMessage({ name: "../../Ценники/прайс.pdf", data: new Uint8Array([37, 80, 68, 70]).buffer });
  assert.equal(f.name, "прайс.pdf");
  assert.equal(f.type, "application/pdf");
  assert.equal(f.size, 4);
  assert.equal(await f.blob.text(), "%PDF");
  assert.equal(fileFromMessage({ name: "a.svg", data: "<svg/>" }).type, "image/svg+xml");
  assert.equal(fileFromMessage({ name: "x", type: "image/png", data: new Blob(["1"]) }).type, "image/png");
  assert.throws(() => fileFromMessage({ name: "a.pdf", data: new ArrayBuffer(0) }), /пустой/);
  assert.throws(() => fileFromMessage({ name: "a.pdf" }), /нет файла/);
  assert.throws(() => fileFromMessage({ name: "a.bin", data: new Uint8Array(MAX_FILE + 1) }), /60 МБ/);
});

test("имена, размеры, что можно встраивать", () => {
  assert.equal(safeFileName('a<b>:c|d?.png'), "a b c d .png");
  assert.equal(safeFileName(""), "файл");
  assert.equal(safeFileName(".."), "файл");
  assert.equal(fileSize(1536 * 1024), "1,5 МБ");
  assert.equal(fileSize(300), "1 КБ");
  assert.ok(embeddableUrl("https://c4erepk0.github.io/cenniki/"));
  assert.ok(embeddableUrl("http://localhost:8800/"));
  assert.ok(!embeddableUrl("http://example.com/"));
  assert.ok(!embeddableUrl("javascript:alert(1)"));
});
