// Задачи в формате плагина Obsidian Tasks: «- [ ] Текст ⏫ 📅 2026-11-10 #ipastore». Порт jarvis/tasks.py.
import { addDays } from "./ru.js";

const TASK_LINE = /^(\s*)[-*+] \[(.)\] (.*)$/;
const DATE = "(\\d{4}-\\d{2}-\\d{2})";
const SIGNS = { due: "📅", scheduled: "⏳", start: "🛫", created: "➕", done: "✅", cancelled: "❌" };
const PRIORITY = [["🔺", 5], ["⏫", 4], ["🔼", 3], ["🔽", 1], ["⏬", 0]];
export const PRIORITY_BY_NAME = { highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬" };
const TAG = /(?<![\w/а-яё])#([\wа-яё][\wа-яё/-]*)/gi;
const SKIP = ["Templates/", "Шаблоны/"];
const STATUS = { " ": "todo", "/": "doing", x: "done", X: "done", "-": "cancelled" };
const MARK = { todo: " ", doing: "/", done: "x", cancelled: "-" };

export function lineHash(line) {
  // короткий стабильный отпечаток строки (FNV-1a), чтобы найти задачу, даже если строки сдвинулись
  let h = 0x811c9dc5;
  for (const ch of line.trim()) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function parseLine(path, lineno, line) {
  const m = TASK_LINE.exec(line);
  if (!m || !(m[2] in STATUS)) return null;
  const body = m[3];
  const dates = {};
  for (const [k, sign] of Object.entries(SIGNS)) {
    const dm = new RegExp(sign + "\\s*" + DATE, "u").exec(body);
    dates[k] = dm ? dm[1] : null;
  }
  let priority = 2;
  for (const [sign, v] of PRIORITY) if (body.includes(sign)) { priority = v; break; }
  const tags = [...body.matchAll(TAG)].map((x) => x[1].toLowerCase());
  let text = body;
  for (const sign of Object.values(SIGNS)) text = text.replace(new RegExp(sign + "\\s*" + DATE, "gu"), "");
  text = text.replace(/🔁[^📅⏳🛫➕✅❌]*/u, "");
  for (const [sign] of PRIORITY) text = text.split(sign).join("");
  text = text.replace(/\s{2,}/g, " ").trim();
  text = text.replace(/(?:\s+#[\wа-яё][\wа-яё/-]*)+$/i, "").trim() || text;
  return { id: `${path}:${lineno}:${lineHash(line)}`, path, line: lineno, text, status: STATUS[m[2]], priority,
    due: dates.due, scheduled: dates.scheduled, created: dates.created, done: dates.done, tags };
}

export function formatTask(text, { due, priority, tags = [], created } = {}) {
  const parts = [text.trim()];
  for (let t of tags) {
    t = t.replace(/^#/, "").trim();
    if (t && !text.toLowerCase().includes(`#${t}`.toLowerCase())) parts.push(`#${t}`);
  }
  if (priority && PRIORITY_BY_NAME[priority]) parts.push(PRIORITY_BY_NAME[priority]);
  if (created) parts.push(`➕ ${created}`);
  if (due) parts.push(`📅 ${due}`);
  return "- [ ] " + parts.join(" ");
}

export class TaskBook {
  constructor(vault, inbox, skip = []) {
    this.vault = vault;
    this.inbox = inbox;
    this.skip = [...SKIP, ...skip];
    this.cache = null;
  }

  all() {
    if (this.cache && this.cache.v === this.vault.version) return this.cache.tasks;
    const out = [];
    for (const rel of this.vault.list()) {
      if (this.skip.some((s) => rel.startsWith(s))) continue;
      let code = false;
      this.vault.read(rel).split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("```")) { code = !code; return; }
        if (code) return;
        const t = parseLine(rel, i, line);
        if (t) out.push(t);
      });
    }
    this.cache = { v: this.vault.version, tasks: out };
    return out;
  }

  view(ref, name = "today", tag = null) {
    let tasks = this.all().filter((t) => t.status === "todo" || t.status === "doing");
    if (tag) {
      tag = tag.toLowerCase().replace(/^#/, "");
      tasks = tasks.filter((t) => t.tags.some((x) => x === tag || x.startsWith(tag + "/")));
    }
    const week = addDays(ref, 7);
    if (name === "today") tasks = tasks.filter((t) => (t.due && t.due <= ref) || (t.scheduled && t.scheduled <= ref)
      || t.status === "doing");
    else if (name === "overdue") tasks = tasks.filter((t) => t.due && t.due < ref);
    else if (name === "week") tasks = tasks.filter((t) => t.due && t.due <= week);
    else if (name === "tomorrow") tasks = tasks.filter((t) => t.due === addDays(ref, 1));
    else if (name === "nodate") tasks = tasks.filter((t) => !t.due && !t.scheduled);
    return tasks.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || b.priority - a.priority
      || a.path.localeCompare(b.path) || a.line - b.line);
  }

  doneOn(day) { return this.all().filter((t) => t.status === "done" && t.done === day); }

  summary(ref) {
    const open = this.all().filter((t) => t.status === "todo" || t.status === "doing");
    return { open: open.length, today: this.view(ref, "today").length,
      overdue: open.filter((t) => t.due && t.due < ref).length, done_today: this.doneOn(ref).length };
  }

  async add(text, ref, { due = null, priority = null, tags = [], note = null } = {}) {
    text = text.trim();
    if (!text) throw new Error("пустая задача");
    const line = formatTask(text, { due, priority, tags, created: ref });
    if (note) await this.vault.appendToSection(note, "Задачи", line);
    else await this.vault.append(this.inbox, line, { header: "# Входящие задачи\n\n" });
    const target = note || this.inbox;
    const lines = this.vault.read(target).split("\n");
    return parseLine(target, lines.lastIndexOf(line), line);
  }

  locate(id, lines) {
    const parts = id.split(":");
    const digest = parts.pop(), lineno = Number(parts.pop());
    if (lineno >= 0 && lineno < lines.length && lineHash(lines[lineno]) === digest) return lineno;
    return lines.findIndex((l) => TASK_LINE.test(l) && lineHash(l) === digest);
  }

  async setStatus(id, status, ref) {
    const path = id.split(":").slice(0, -2).join(":");
    let result = null;
    await this.vault.update(path, (cur) => {
      const lines = (cur || "").split("\n");
      const i = this.locate(id, lines);
      if (i < 0) throw new Error("задача не найдена — возможно, её уже изменили");
      const m = TASK_LINE.exec(lines[i]);
      let body = m[3].replace(new RegExp("\\s*[✅❌]\\s*" + DATE, "gu"), "");
      if (status === "done") body += ` ✅ ${ref}`;
      if (status === "cancelled") body += ` ❌ ${ref}`;
      lines[i] = `${m[1]}- [${MARK[status]}] ${body}`;
      result = parseLine(path, i, lines[i]);
      return lines.join("\n");
    });
    return result;
  }

  find(query) {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const open = this.all().filter((t) => t.status === "todo" || t.status === "doing");
    const exact = open.filter((t) => t.text.toLowerCase().includes(q));
    if (exact.length) return exact;
    const words = (q.match(/[\wа-яё]+/gi) || []).filter((w) => w.length > 2);
    return open.filter((t) => words.length && words.every((w) => t.text.toLowerCase().includes(w.slice(0, 5))));
  }

  async archiveDone(ref, olderThan = 7, archive = "Tasks/Archive.md") {
    if (!this.vault.exists(this.inbox)) return 0;
    const border = addDays(ref, -olderThan);
    const keep = [], moved = [];
    this.vault.read(this.inbox).split("\n").forEach((line, i) => {
      const t = parseLine(this.inbox, i, line);
      if (t && (t.status === "done" || t.status === "cancelled") && (t.done || t.created || "0000") <= border) moved.push(line);
      else keep.push(line);
    });
    if (moved.length) {
      await this.vault.append(archive, moved.join("\n"), { header: "# Архив задач\n\n" });
      await this.vault.write(this.inbox, keep.join("\n").replace(/\n*$/, "\n"));
    }
    return moved.length;
  }
}
