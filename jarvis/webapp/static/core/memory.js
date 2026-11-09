// Память Jarvis в Obsidian: факты, профиль, журнал дня, разговоры, напоминания. Порт jarvis/memory.py.
import { parseFrontmatter } from "./vault.js";

const FACT = /^- (?:(\d{4}-\d{2}-\d{2}) — )?(.+)$/;
// Напоминание: «- ⏰ 2026-11-09T14:30:00+03:00 — позвонить маме». Не похоже на задачу, чтобы не мешаться в списках.
const REMINDER = /^- ⏰ (\S+) — (.+)$/;
const pad = (n) => String(n).padStart(2, "0");
export const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export class Memory {
  constructor(vault, dir = "Jarvis", journal = "Journal") {
    this.vault = vault;
    this.dir = dir;
    this.journalDir = journal;
  }

  get memoryPath() { return `${this.dir}/Memory.md`; }
  get profilePath() { return `${this.dir}/Profile.md`; }
  get remindersPath() { return `${this.dir}/Reminders.md`; }

  facts() {
    if (!this.vault.exists(this.memoryPath)) return [];
    return this.vault.read(this.memoryPath).split("\n").map((l) => FACT.exec(l.trim())).filter(Boolean)
      .map((m) => ({ date: m[1] || null, text: m[2].trim() }));
  }

  async remember(fact, day) {
    fact = fact.replace(/\s+/g, " ").trim().replace(/\.$/, "");
    if (!fact) throw new Error("пустой факт");
    if (this.facts().some((f) => f.text.toLowerCase() === fact.toLowerCase())) return { text: fact, duplicate: true };
    await this.vault.appendToSection(this.memoryPath, "Факты", `- ${day} — ${fact}`, {
      header: "# Память Jarvis\n\nЗдесь Jarvis хранит то, что узнал о вас. Можно править вручную.\n\n" });
    return { date: day, text: fact };
  }

  async forget(needle) {
    needle = needle.toLowerCase().trim();
    if (needle.length < 3 || !this.vault.exists(this.memoryPath)) return 0;
    let removed = 0;
    await this.vault.update(this.memoryPath, (cur) => cur.split("\n").filter((l) => {
      const hit = FACT.test(l.trim()) && l.toLowerCase().includes(needle);
      if (hit) removed++;
      return !hit;
    }).join("\n"));
    return removed;
  }

  profile() {
    if (!this.vault.exists(this.profilePath)) return "";
    return parseFrontmatter(this.vault.read(this.profilePath))[1].trim();
  }

  journalPath(day) { return `${this.journalDir}/${day}.md`; }

  logEvent(text, day, time) {
    return this.vault.appendToSection(this.journalPath(day), "Журнал Jarvis", `- ${time} ${text}`,
      { header: `# ${day}\n\n` });
  }

  logDialog(user, reply, day, time, source = "") {
    const src = source && source !== "dashboard" ? ` · ${source}` : "";
    return this.vault.append(`${this.dir}/Conversations/${day}.md`,
      `\n**Вы (${time}${src}):** ${user.trim()}\n\n**Jarvis:** ${reply.trim()}\n`, { header: `# Разговоры — ${day}\n` });
  }

  // ---------- напоминания (их же читает GitHub Actions и шлёт в Telegram, когда приложение закрыто) ----------
  reminders() {
    if (!this.vault.exists(this.remindersPath)) return [];
    return this.vault.read(this.remindersPath).split("\n").map((l) => REMINDER.exec(l.trim())).filter(Boolean)
      .map((m) => ({ id: m[1], at: Date.parse(m[1]) / 1000, text: m[2].trim() })).filter((r) => !Number.isNaN(r.at));
  }

  async addReminder(text, atDate) {
    const iso = isoWithOffset(atDate);
    await this.vault.append(this.remindersPath, `- ⏰ ${iso} — ${text.trim()}`, {
      header: "# Напоминания\n\nJarvis напомнит голосом и в Telegram. Формат: `- ⏰ время — текст`.\n\n" });
    return { id: iso, at: atDate.getTime() / 1000, text: text.trim() };
  }

  async removeReminders(ids) {
    if (!ids.length || !this.vault.exists(this.remindersPath)) return;
    const set = new Set(ids);
    await this.vault.update(this.remindersPath, (cur) => cur.split("\n").filter((l) => {
      const m = REMINDER.exec(l.trim());
      return !(m && set.has(m[1]));
    }).join("\n"));
  }
}

export function isoWithOffset(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
    + `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
