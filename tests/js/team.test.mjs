// Операторы и встречи: помощники интерфейса (team.js) и встречи в ядре для iPhone — как в Python (meetings.py).
import assert from "node:assert/strict";
import { test } from "node:test";

import { chatDays, inviteLink, inviteToken, seen } from "../../jarvis/webapp/static/team.js";
import { asMeeting, meetingText, meetings } from "../../jarvis/webapp/static/core/meetings.js";
import { parse } from "../../jarvis/webapp/static/core/intents.js";
import { Jarvis } from "../../jarvis/webapp/static/core/jarvis.js";
import { LocalStore } from "../../jarvis/webapp/static/core/vault.js";

test("приглашение: код из ссылки и обратно", () => {
  const code = "AbC_dEf-123456789012345678901234";
  assert.equal(inviteToken(`https://atom.example/?invite=${code}`), code);
  assert.equal(inviteToken(` ${code} `), code);
  assert.equal(inviteToken("привет"), "");
  assert.equal(inviteLink("https://atom.example/", code), `https://atom.example/?invite=${code}`);
});

test("чат по дням и «был в сети»", () => {
  const days = chatDays([{ date: "2026-11-18", text: "a" }, { date: "2026-11-19", text: "b" }, { date: "2026-11-19", text: "c" }], "2026-11-19");
  assert.deepEqual(days.map((d) => [d.label, d.items.length]), [["Вчера", 1], ["Сегодня", 2]]);
  assert.equal(seen(1000, 1060), "в сети");
  assert.equal(seen(1000, 1000 + 600), "был(а) 10 мин назад");
  assert.equal(seen(null), "ещё не заходил(а)");
});

test("встречи — как в Python", () => {
  assert.equal(meetingText("Созвон с поставщиком", "9:30", "Zoom"), "Созвон с поставщиком 🕒 09:30 📍 Zoom");
  assert.throws(() => meetingText("x", "утром"));
  const m = asMeeting({ id: "1", text: "Созвон с поставщиком 🕒 09:30 📍 Zoom", status: "todo", due: "2026-11-20", tags: ["встреча", "оператор/анна"] });
  assert.deepEqual([m.title, m.time, m.place, m.assignees], ["Созвон с поставщиком", "09:30", "Zoom", ["анна"]]);
  const tasks = [
    { id: "a", text: "Б 🕒 15:00", status: "todo", due: "2026-11-19", tags: ["встреча"] },
    { id: "b", text: "А 🕒 09:00", status: "todo", due: "2026-11-19", tags: ["встреча", "оператор/анна"] },
    { id: "c", text: "Старая", status: "done", due: "2026-11-01", done: "2026-11-01", tags: ["встреча"] },
    { id: "d", text: "Не встреча", status: "todo", due: "2026-11-19", tags: [] },
  ];
  const r = meetings(tasks, "2026-11-19");
  assert.deepEqual(r.upcoming.map((x) => x.id), ["b", "a"]);
  assert.equal(r.today, 2);
  assert.deepEqual(r.done, []);
  assert.deepEqual(meetings(tasks, "2026-11-19", { opSlug: "анна" }).upcoming.map((x) => x.id), ["b"]);
});

test("ядро для iPhone: встреча, отметка, голосом «встречи на завтра»", async () => {
  assert.deepEqual(parse("встречи на завтра", "2026-11-19"), { name: "meetings", args: { period: "завтра" } });
  assert.deepEqual(parse("какие встречи", "2026-11-19"), { name: "meetings", args: { period: "all" } });
  const j = await new Jarvis({ title: "сэр" }, { store: new LocalStore("team", {}), clock: () => new Date(2026, 10, 19, 10), fetchImpl: async () => { throw new TypeError("offline"); } }).init();
  const t = await j.request("POST", "/api/admin/assign", { kind: "meeting", title: "Встреча с юристом", time: "15:00", place: "Офис", due: "2026-11-20" });
  assert.match(j.vault.read("Tasks/Inbox.md"), /- \[ \] Встреча с юристом 🕒 15:00 📍 Офис #встреча ➕ 2026-11-19 📅 2026-11-20/);
  const mt = await j.request("GET", "/api/meetings", {});
  assert.equal(mt.upcoming[0].place, "Офис");
  const reply = await j.handle("встречи на завтра");
  assert.match(reply.text, /1 встреча на завтра: Встреча с юристом в 15:00/);
  await j.request("POST", `/api/tasks/${encodeURIComponent(t.id)}/status`, { status: "done" });
  assert.equal((await j.request("GET", "/api/meetings", {})).upcoming.length, 0);
});
