// Каталог приложений: заметки с type: app и проекты с catalog: true. Порт jarvis/apps.py.
import { parseFrontmatter, setFrontmatterField, title } from "./vault.js";
import { STATUSES } from "./projects.js";

const YES = new Set(["true", "yes", "да", "1", "on"]);
const s = (meta, k) => { const v = meta[k]; return v === undefined || v === null || v === false || (Array.isArray(v) && !v.length) ? "" : String(v).trim(); };
const desc = (body) => (body.split("\n").map((l) => l.trim()).find((l) => l && !/^(#|-|\||>|!\[)/.test(l)) || "").slice(0, 200);

export function catalog(vault, projects) {
  const apps = [], seen = new Set();
  const list = projects.list();
  for (const p of list) {
    const [meta] = parseFrontmatter(vault.read(p.note));
    if (!YES.has(s(meta, "catalog").toLowerCase())) continue;
    seen.add(p.note);
    apps.push({ name: p.name, note: p.note, kind: "project", description: p.description, status: p.status,
      status_label: STATUSES[p.status] || p.status, repo: p.repo, url: p.url, icon: s(meta, "icon") });
  }
  for (const rel of vault.list("")) {
    if (seen.has(rel)) continue;
    const [meta, body] = parseFrontmatter(vault.read(rel));
    if (meta.type !== "app") continue;
    const status = s(meta, "status") || "active";
    apps.push({ name: s(meta, "name") || title(rel), note: rel, kind: "app", description: s(meta, "description") || desc(body),
      status, status_label: STATUSES[status] || status, repo: s(meta, "repo"), url: s(meta, "url"), icon: s(meta, "icon") });
  }
  const key = (a) => [a.status === "done" ? 1 : 0, a.name.toLowerCase()];
  apps.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0); });
  const notes = new Set(apps.map((a) => a.note));
  return { apps, available: list.filter((p) => !notes.has(p.note)).map((p) => p.name) };
}

export async function setInCatalog(vault, projects, name, on) {
  const p = projects.list().find((x) => x.name === name) || projects.get(name);
  if (!p) throw new Error(`нет проекта «${name}»`);
  await vault.update(p.note, (cur) => setFrontmatterField(cur ?? "", "catalog", on ? "true" : "false"),
    `Atom: ${on ? "в каталог" : "из каталога"} ${p.name}`);
  return catalog(vault, projects);
}
