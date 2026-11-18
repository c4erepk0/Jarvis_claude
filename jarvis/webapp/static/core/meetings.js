// Встречи и поручения поверх задач Obsidian Tasks — порт jarvis/meetings.py.
// «- [ ] Созвон 🕒 15:00 📍 Zoom #встреча #оператор/иван 📅 2026-11-20»
export const MEET_TAG = "встреча";
export const OP_TAG = "оператор/";
const TIME = /🕒\s*(\d{1,2}:\d{2})/u;
const PLACE = /📍\s*([^🕒📍#]+)/u;

export function meetingText(title, time = "", place = "") {
  title = String(title || "").replace(/[🕒📍]/gu, "").trim();
  if (!title) throw new Error("укажите, что за встреча");
  time = String(time || "").trim();
  if (time && !/^\d{1,2}:\d{2}$/.test(time)) throw new Error("время — в виде 15:00");
  const parts = [title];
  if (time) { const [h, m] = time.split(":"); parts.push(`🕒 ${String(Number(h)).padStart(2, "0")}:${m}`); }
  place = String(place || "").replace(/[#🕒📍]/gu, "").trim();
  if (place) parts.push(`📍 ${place}`);
  return parts.join(" ");
}

export const assignees = (tags = []) => tags.filter((t) => t.startsWith(OP_TAG) && t.length > OP_TAG.length).map((t) => t.slice(OP_TAG.length));
export const isMeeting = (t) => (t.tags || []).includes(MEET_TAG);

export function asMeeting(t) {
  const tm = TIME.exec(t.text), pl = PLACE.exec(t.text);
  const title = t.text.replace(new RegExp(PLACE.source, "gu"), "").replace(new RegExp(TIME.source, "gu"), "").replace(/\s{2,}/g, " ").trim();
  return { ...t, title, time: tm ? tm[1].padStart(5, "0") : "", place: pl ? pl[1].trim() : "", assignees: assignees(t.tags) };
}

export function forOperator(tasks, slug) {
  if (slug === null || slug === undefined) return [...tasks];
  return tasks.filter((t) => (t.tags || []).includes(OP_TAG + slug));
}

const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function meetings(tasks, refIso, { opSlug = null, pastDays = 7 } = {}) {
  const items = forOperator(tasks.filter(isMeeting), opSlug).map(asMeeting);
  const upcoming = items.filter((m) => m.status === "todo" || m.status === "doing")
    .sort((a, b) => cmp(a.due || "9999-99-99", b.due || "9999-99-99") || cmp(a.time || "99:99", b.time || "99:99") || cmp(a.title, b.title));
  const cutoff = shift(refIso, -pastDays);
  const done = items.filter((m) => (m.status === "done" || m.status === "cancelled") && (m.done || m.due || "") >= cutoff)
    .sort((a, b) => cmp(b.done || b.due || "", a.done || a.due || "") || cmp(b.time, a.time));
  return { upcoming, done, overdue: upcoming.filter((m) => m.due && m.due < refIso).length,
    today: upcoming.filter((m) => m.due === refIso).length };
}
