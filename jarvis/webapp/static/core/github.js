// GitHub REST API из браузера: хранилище, статус проектов, задачи для @claude, деплой.

export class GitHubError extends Error {
  constructor(status, message) { super(`GitHub ${status}: ${message}`); this.status = status; }
}

export class GitHub {
  constructor(token, { base = "https://api.github.com", fetchImpl = (...a) => fetch(...a) } = {}) {
    this.token = token;
    this.base = base.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.etags = new Map();
    this.cache = new Map();
    this.rate = null;          // { remaining, limit, reset }
  }

  async request(method, path, { body, query, etag = false, cacheTtl = 0 } = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const key = `${method} ${url}`;
    if (cacheTtl && method === "GET") {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.t < cacheTtl * 1000) return hit.data;
    }
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body) headers["Content-Type"] = "application/json";
    if (etag && this.etags.has(key)) headers["If-None-Match"] = this.etags.get(key);
    const r = await this.fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined,
      cache: "no-store" });
    const rem = r.headers.get("x-ratelimit-remaining");
    if (rem !== null) this.rate = { remaining: Number(rem), limit: Number(r.headers.get("x-ratelimit-limit")),
      reset: Number(r.headers.get("x-ratelimit-reset")) };
    if (r.status === 304) return null;
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw new GitHubError(r.status, (data && data.message) || r.statusText);
    if (etag && r.headers.get("etag")) this.etags.set(key, r.headers.get("etag"));
    if (cacheTtl && method === "GET") this.cache.set(key, { t: Date.now(), data });
    return data;
  }

  invalidate(repo) {
    for (const k of [...this.cache.keys()]) if (k.includes(`/repos/${repo}`)) this.cache.delete(k);
  }

  async user() { return this.request("GET", "/user", { cacheTtl: 3600 }); }

  async repoStatus(repo) {
    const info = await this.request("GET", `/repos/${repo}`, { cacheTtl: 60 });
    const branch = info.default_branch || "main";
    const [commits, runs, pulls, issues] = await Promise.allSettled([
      this.request("GET", `/repos/${repo}/commits`, { query: { sha: branch, per_page: 1 }, cacheTtl: 60 }),
      this.request("GET", `/repos/${repo}/actions/runs`, { query: { branch, per_page: 30 }, cacheTtl: 60 }),
      this.request("GET", `/repos/${repo}/pulls`, { query: { state: "open", per_page: 10 }, cacheTtl: 60 }),
      this.request("GET", `/repos/${repo}/issues`, { query: { state: "open", per_page: 20 }, cacheTtl: 60 }),
    ]);
    const out = { repo, url: info.html_url, branch, private: info.private, pushed_at: info.pushed_at };
    if (commits.status === "fulfilled" && commits.value.length) {
      const c = commits.value[0];
      out.last_commit = { sha: c.sha.slice(0, 7), message: (c.commit.message || "").split("\n")[0].slice(0, 120),
        author: c.commit.author && c.commit.author.name, date: c.commit.author && c.commit.author.date, url: c.html_url };
    }
    if (runs.status === "fulfilled") {
      const ci = ciFromRuns(runs.value.workflow_runs || []);
      if (ci) out.ci = ci;
    }
    if (pulls.status === "fulfilled") {
      out.pulls = pulls.value.map((p) => ({ number: p.number, title: p.title, draft: p.draft, url: p.html_url,
        user: p.user && p.user.login }));
    }
    if (issues.status === "fulfilled") {
      out.issues = issues.value.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title,
        url: i.html_url, labels: (i.labels || []).map((l) => l.name) }));
    }
    return out;
  }

  async createIssue(repo, title, body) {
    const d = await this.request("POST", `/repos/${repo}/issues`, { body: { title, body } });
    this.invalidate(repo);
    return { number: d.number, url: d.html_url, title: d.title };
  }

  async dispatch(repo, workflow, ref) {
    if (!ref) ref = (await this.request("GET", `/repos/${repo}`, { cacheTtl: 60 })).default_branch || "main";
    await this.request("POST", `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { body: { ref } });
    this.invalidate(repo);
  }
}

export function ciFromRuns(runs) {
  if (!runs.length) return null;
  const meaningful = runs.filter((r) => !["skipped", "neutral"].includes(r.conclusion));
  const pool = meaningful.length ? meaningful : runs;
  const preferred = pool.filter((r) => ["ci", "tests", "test", "build"].includes((r.name || "").toLowerCase()));
  const run = (preferred.length ? preferred : pool)[0];
  return { id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url,
    event: run.event, created_at: run.created_at, title: run.display_title };
}
