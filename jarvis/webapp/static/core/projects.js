// Проекты: заметки Projects/*.md + живой статус GitHub, health и метрики (например, IPAStore /jarvis/stats).
import { parseFrontmatter, title } from "./vault.js";

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
      if (meta.type && meta.type !== "project") continue;
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
