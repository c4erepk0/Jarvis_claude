// Проекты: заметки Projects/*.md + живой статус GitHub, health и метрики (например, IPAStore /jarvis/stats).
import { VaultError, dumpFrontmatter, parseFrontmatter, setFrontmatterField, title } from "./vault.js";

export const STATUSES = { idea: "идея", active: "в работе", paused: "на паузе", done: "завершён" };
export const slug = (name) => String(name).trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^[-_]+|[-_]+$/g, "") || "project";

const s = (meta, k) => {
  const v = meta[k];
  return v === undefined || v === null || v === false || (Array.isArray(v) && !v.length) ? "" : String(v).trim();
};

export const CI_WORDS = { success: "сборка зелёная", failure: "сборка упала", cancelled: "сборка отменена",
  timed_out: "сборка зависла", skipped: "сборка пропущена", action_required: "сборка ждёт одобрения" };

export class Projects {
  constructor(vault, folder, github, { fetchImpl = (...a) => fetch(...a), statsToken = () => "" } = {}) {
    this.vault = vault;
    this.folder = folder;
    this.gh = github;
    this.fetch = fetchImpl;
    this.statsToken = statsToken;
    this.health = new Map();
  }

  list() {
    const out = [];
    for (const rel of this.vault.list(this.folder)) {
      const [meta, body] = parseFrontmatter(this.vault.read(rel));
      const nested = rel.slice(this.folder.length + 1).includes("/");     // Projects/IPAStore/Встреча.md — заметка проекта
      if ((meta.type && meta.type !== "project") || (nested && meta.type !== "project")) continue;
      const name = title(rel);
      const desc = body.split("\n").map((l) => l.trim()).find((l) => l && !/^[#\-|>]/.test(l)) || "";
      out.push({ name, note: rel, status: s(meta, "status") || "active", repo: s(meta, "repo"), path: s(meta, "path"),
        tag: (s(meta, "tag") || name).toLowerCase(), health: s(meta, "health"), stats_url: s(meta, "stats_url"),
        deploy_workflow: s(meta, "deploy_workflow"), url: s(meta, "url"), description: desc.slice(0, 200) });
    }
    return out;
  }

  get(name) {
    const key = String(name || "").toLowerCase().trim();
    const all = this.list();
    return all.find((p) => p.name.toLowerCase() === key || p.tag === key)
      || all.find((p) => key && (p.name.toLowerCase().includes(key) || key.includes(p.name.toLowerCase()))) || null;
  }

  async checkHealth(p) {
    if (!p.health) return null;
    const hit = this.health.get(p.health);
    if (hit && Date.now() - hit.t < 30000) return hit.v;
    const t0 = Date.now();
    let v;
    try {
      // без CORS браузер не покажет код ответа, но «достучался» = сервис жив
      const r = await this.fetch(p.health, { mode: "no-cors", cache: "no-store" });
      v = { ok: r.type === "opaque" || r.ok, status: r.status || null, latency_ms: Date.now() - t0 };
    } catch (e) {
      v = { ok: false, status: null, error: e.name, latency_ms: null };
    }
    this.health.set(p.health, { t: Date.now(), v });
    return v;
  }

  async stats(p) {
    if (!p.stats_url) return null;
    const token = this.statsToken(p);
    try {
      const r = await this.fetch(p.stats_url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return await r.json();
    } catch (e) {
      return { error: e.name };
    }
  }

  async status(p) {
    const out = { ...p };
    const [gh, health, stats] = await Promise.allSettled([
      p.repo && this.gh ? this.gh.repoStatus(p.repo) : Promise.resolve(null), this.checkHealth(p), this.stats(p)]);
    if (gh.status === "rejected") {
      const e = gh.reason;
      out.github_error = e && [401, 403, 404].includes(e.status) ? "нет доступа — проверьте токен GitHub"
        : `GitHub недоступен: ${e && e.message}`;
    } else if (gh.value) out.github = gh.value;
    out.health = health.status === "fulfilled" ? health.value : { ok: false };
    out.stats = stats.status === "fulfilled" ? stats.value : null;
    return out;
  }

  statusAll() { return Promise.all(this.list().map((p) => this.status(p))); }

  getExact(name) {
    const key = String(name || "").toLowerCase().trim();
    return this.list().find((p) => p.name.toLowerCase() === key) || null;
  }

  folderOf(p) { return p.note.replace(/\.[^./]+$/, ""); }

  /** Новый проект — как Projects.create в jarvis/projects.py. stamp — «ГГГГ-ММ-ДД ЧЧ:ММ». */
  async create(name, stamp, { description = "", repo = "", tag = "", status = "active" } = {}) {
    name = String(name || "").replace(/[\\/:*?"<>|#^[\]]+/g, " ").trim();
    if (!name) throw new Error("назовите проект");
    if (this.getExact(name)) throw new Error(`проект «${name}» уже есть`);
    if (!STATUSES[status]) throw new Error("статус: idea, active, paused или done");
    const rel = `${this.folder}/${name}.md`;
    if (this.vault.exists(rel)) throw new VaultError(`заметка «${rel}» уже есть`);
    const meta = { type: "project", status, tag: slug(tag || name), repo: String(repo).trim(), created: stamp.slice(0, 10) };
    const body = `# ${name}\n\n${String(description).trim() || "Описание проекта."}\n\n## Задачи\n\n## Заметки\n\n## Журнал\n- ${stamp} Проект создан\n`;
    await this.vault.write(rel, dumpFrontmatter(meta) + body, `Jarvis: новый проект ${name}`);
    return this.getExact(name);
  }

  async setField(p, key, value) {
    if (key === "status" && !STATUSES[value]) throw new Error("статус: idea, active, paused или done");
    if (!["status", "repo", "tag", "url", "health", "path", "deploy_workflow"].includes(key)) {
      throw new Error(`поле ${key} так не меняется — поправьте заметку проекта`);
    }
    await this.vault.update(p.note, (cur) => setFrontmatterField(cur ?? "", key, String(value).trim()), `Jarvis: ${p.name} — ${key}`);
    return this.getExact(p.name) || p;
  }

  /** Страница проекта: задачи (по тегу, в заметке и папке проекта), прогресс, заметки, журнал. */
  overview(p, tasks, files, linked) {
    const folder = `${this.folderOf(p)}/`;
    const mine = tasks.filter((t) => t.tags.includes(p.tag) || t.path === p.note || t.path.startsWith(folder));
    const open = mine.filter((t) => t.status === "todo" || t.status === "doing")
      .sort((a, b) => b.priority - a.priority || (a.due || "9999").localeCompare(b.due || "9999") || a.text.localeCompare(b.text));
    const done = mine.filter((t) => t.status === "done").sort((a, b) => (b.done || "").localeCompare(a.done || ""));
    const journal = [];
    let inJournal = false;
    for (const line of this.vault.read(p.note).split("\n")) {
      if (/^#{1,2} /.test(line)) inJournal = line.trim().toLowerCase() === "## журнал";
      else if (inJournal && line.trim().startsWith("- ")) journal.push(line.trim().slice(2));
    }
    const notes = files.filter((f) => f.path.startsWith(folder));
    const seen = new Set([...notes.map((n) => n.path), p.note]);
    for (const n of linked) if (!seen.has(n.path)) notes.push(n);
    const total = open.length + done.length;
    return { ...p, status_label: STATUSES[p.status] || p.status, folder: folder.slice(0, -1),
      progress: { done: done.length, total, percent: total ? Math.round((100 * done.length) / total) : 0 },
      tasks: open, done: done.slice(0, 10), notes: notes.map((n) => ({ path: n.path, title: n.title })),
      journal: journal.slice(-12).reverse() };
  }

  async log(p, text, stamp) {
    await this.vault.appendToSection(p.note, "Журнал", `- ${stamp} ${text}`);
  }

  async delegateGithub(p, task, stamp) {
    if (!p.repo) throw new Error(`у проекта ${p.name} не указан repo`);
    const t = task.trim().split("\n")[0].slice(0, 90);
    const body = `${task.trim()}\n\n---\n@claude возьми эту задачу: следуй CLAUDE.md, прогони проверки и открой PR с описанием на русском.\n\n_Поручено через Jarvis с iPhone, ${stamp}._`;
    const issue = await this.gh.createIssue(p.repo, t, body);
    await this.log(p, `Поручено @claude: [#${issue.number} ${t}](${issue.url})`, stamp);
    return issue;
  }

  async deploy(p, stamp) {
    if (!p.repo || !p.deploy_workflow) throw new Error(`у проекта ${p.name} не настроен deploy_workflow`);
    await this.gh.dispatch(p.repo, p.deploy_workflow);
    await this.log(p, `Запущен деплой (${p.deploy_workflow})`, stamp);
    return { ok: true, url: `https://github.com/${p.repo}/actions/workflows/${p.deploy_workflow}` };
  }
}

export function projectLine(st) {
  const gh = st.github || {}, ci = gh.ci;
  const bits = [];
  if (ci) bits.push(ci.status !== "completed" ? "сборка идёт" : CI_WORDS[ci.conclusion] || "сборка с ошибкой");
  else if (st.github_error) bits.push(st.github_error);
  if (st.github) bits.push(`PR открыто ${(gh.pulls || []).length}, задач ${(gh.issues || []).length}`);
  if (st.health) bits.push(st.health.ok ? "сервис в сети" : "сервис НЕ отвечает");
  const s2 = st.stats;
  if (s2 && !s2.error && "users" in s2) {
    bits.push(`пользователей ${s2.users}`);
    if (s2.new_users_24h) bits.push(`новых за сутки ${s2.new_users_24h}`);
    if (s2.stars_24h) bits.push(`звёзд за сутки ${s2.stars_24h}`);
    const waiting = (s2.open_reports || 0) + (s2.pending_devs || 0) + (s2.pending_apps || 0);
    if (waiting) bits.push(`ждут модерации ${waiting}`);
  }
  return bits.length ? `${st.name}: ${bits.join(", ")}.` : `${st.name}: нет данных.`;
}
