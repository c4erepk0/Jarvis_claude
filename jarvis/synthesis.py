"""Умный синтез проектов: какие заметки хранилища относятся к проектам и какие проекты в нём «спрятаны».

Работает без модели, по индексу хранилища (`Notes.index()`: теги, ссылки, папки, тип заметки) — быстро,
бесплатно и одинаково на сервере и на iPhone (то же — `webapp/static/core/synthesis.js`).

1. **Заметки проектов.** К проекту относятся его заметка, папка `Projects/<Проект>/`, заметки с его тегом,
   заметки со ссылкой [[Проект]] и заметки, где есть задачи с тегом проекта.
   Оглавление со ссылками на несколько проектов (Home.md) — не заметка проекта.
2. **Кандидаты в проекты** — то, что выглядит как проект, но им ещё не оформлено:
   - заметка с `type: project` вне папки проектов;
   - тег, который встречается в нескольких заметках и задачах (#сайт-студии);
   - папка с несколькими заметками (Ideas/Ремонт/…);
   - «узел» — заметка, на которую ссылаются несколько других.
   Совпадающие по названию кандидаты сливаются в один, у каждого — причины и вес.
3. **Подсветка** — путь заметки → проект или кандидат, к которому она относится: её показывают дерево
   хранилища и граф.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

# служебные папки хранилища — их заметки не складываются в кандидаты (но могут относиться к проекту по тегу)
SYSTEM_DIRS = {"jarvis", "atom", "journal", "finance", "tasks", "templates", ".trash", ".obsidian",
               "attachments", "daily", "archive", "архив"}
# папки-«склады»: заметки в них бывают о чём угодно — сами по себе не проект
GENERIC_DIRS = {"notes", "заметки", "ideas", "идеи", "inbox", "входящие", "misc", "разное", "resources", "ресурсы",
                "people", "люди", "projects", "проекты", "areas", "сферы", "references", "files", "файлы"}
# слишком общие теги — не проекты
STOP_TAGS = {"todo", "inbox", "idea", "ideas", "идея", "идеи", "daily", "journal", "важно", "important",
             "встреча", "meeting", "заметка", "note", "draft", "черновик", "project", "проект", "task", "задача"}
MIN_TAG_NOTES = 2          # тег — кандидат, если он в ≥ 2 заметках и (заметок + открытых задач) ≥ 3
MIN_TAG_WEIGHT = 3
MIN_FOLDER_NOTES = 3       # папка — кандидат, если в ней ≥ 3 заметок
MIN_HUB_LINKS = 3          # узел — на заметку ссылаются ≥ 3 других
LIMIT = 12


def slug(name: str) -> str:
    """Как Projects.slug: «Сайт студии» → «сайт-студии»."""
    return re.sub(r"[^\w\-]+", "-", str(name).strip().lower()).strip("-_") or "project"


def _key(name: str) -> str:
    return slug(name).replace("ё", "е").replace("_", "-")


def tag_title(tag: str) -> str:
    """#сайт-студии → «Сайт студии», #ipastore → «Ipastore» (название — с заглавной, дефисы — пробелы)."""
    words = re.sub(r"[-_/]+", " ", tag).strip()
    return words[:1].upper() + words[1:]


def _noext(rel: str) -> str:
    return rel[: -len(Path(rel).suffix)] if Path(rel).suffix else rel


def _is_system(rel: str) -> bool:
    top = rel.split("/", 1)[0].lower()
    return top in SYSTEM_DIRS or top.startswith(".")


def synthesize(files: list[dict[str, Any]], projects: Iterable[dict[str, Any]], tasks: Iterable[dict[str, Any]],
               *, projects_dir: str = "Projects", limit: int = LIMIT) -> dict:
    """files — `index()["files"]` (path, title, folder, tags, type, links); projects — name, note, tag, status;
    tasks — path, tags, open. Ответ: {projects, candidates, highlight}."""
    projects_dir = projects_dir.strip("/")
    notes = [f for f in files if f.get("ext", Path(f["path"]).suffix.lower()) in (".md", ".txt")]
    by_path = {f["path"]: f for f in notes}
    by_title: dict[str, str] = {}
    for f in notes:
        by_title.setdefault(f["title"].lower(), f["path"])
        by_title.setdefault(_noext(f["path"]).lower(), f["path"])
    tasks = list(tasks)

    def resolve(target: str) -> str | None:
        t = _noext(target.strip()).lower() if target.lower().endswith((".md", ".txt")) else target.strip().lower()
        return by_title.get(t) or by_title.get(t.rsplit("/", 1)[-1])

    # кто на кого ссылается
    linked_by: dict[str, set[str]] = {}
    for f in notes:
        for target in f.get("links") or []:
            dst = resolve(target)
            if dst and dst != f["path"]:
                linked_by.setdefault(dst, set()).add(f["path"])
    task_tags: dict[str, set[str]] = {}            # заметка → теги её задач
    open_by_tag: dict[str, int] = {}
    for t in tasks:
        for tag in t.get("tags") or []:
            task_tags.setdefault(t["path"], set()).add(tag)
            if t.get("open"):
                open_by_tag[tag] = open_by_tag.get(tag, 0) + 1

    # ---------- 1. заметки существующих проектов ----------
    projects = list(projects)
    # оглавление (Home.md со ссылками на все проекты) — не заметка какого-то одного проекта
    project_notes = {p["note"] for p in projects}
    hubs = {f["path"] for f in notes
            if len({d for t in f.get("links") or [] if (d := resolve(t)) in project_notes}) > 1}
    out_projects, highlight = [], {}
    taken: set[str] = set()
    project_keys: set[str] = set()
    for p in projects:
        note, tag = p["note"], (p.get("tag") or slug(p["name"])).lower()
        folder = _noext(note) + "/"
        project_keys |= {_key(p["name"]), _key(tag)}
        members = {note}
        for f in notes:
            rel = f["path"]
            if rel.startswith(folder) or tag in (f.get("tags") or []) or tag in task_tags.get(rel, set()):
                members.add(rel)
        members |= linked_by.get(note, set()) - hubs
        members |= {dst for t in (by_path.get(note) or {}).get("links") or [] if (dst := resolve(t))}   # «Материалы»
        members = {m for m in members if m in by_path}
        ordered = [note] + sorted(members - {note})
        out_projects.append({"name": p["name"], "note": note, "tag": tag, "status": p.get("status", "active"),
                             "notes": ordered, "open_tasks": open_by_tag.get(tag, 0)})
        for rel in ordered:
            highlight.setdefault(rel, {"kind": "project", "project": p["name"]})
        taken |= members

    # ---------- 2. кандидаты ----------
    cands: dict[str, dict[str, Any]] = {}

    def add(name: str, kind: str, reason: str, members: Iterable[str], *, tag: str = "", weight: int = 0) -> None:
        key = _key(tag or name)
        if key in project_keys or not key:
            return
        c = cands.setdefault(key, {"name": name, "tag": tag or slug(name), "kinds": [], "reasons": [],
                                   "notes": set(), "bonus": 0})
        if kind not in c["kinds"]:
            c["kinds"].append(kind)
        c["reasons"].append(reason)
        c["notes"] |= set(members)
        c["bonus"] += weight
        if kind in ("note", "folder"):                 # название папки или заметки — точнее, чем тег
            c["name"] = name

    def free(rel: str) -> bool:
        return rel not in taken and not _is_system(rel)

    in_projects_dir = (projects_dir + "/") if projects_dir else ""
    for f in notes:                                    # а) заметка с type: project вне папки проектов
        if f.get("type") == "project" and not f["path"].startswith(in_projects_dir) and free(f["path"]):
            add(f["title"], "note", "заметка помечена как проект (type: project)",
                [f["path"], *(x for x in linked_by.get(f["path"], ()) if free(x))], weight=5)

    tag_notes: dict[str, set[str]] = {}               # б) тег в нескольких заметках и задачах
    for f in notes:
        if not free(f["path"]):
            continue
        for tag in set(f.get("tags") or []) | task_tags.get(f["path"], set()):
            tag_notes.setdefault(tag, set()).add(f["path"])
    for tag, members in tag_notes.items():
        if tag in STOP_TAGS or tag.isdigit() or len(tag) < 3:
            continue
        opened = open_by_tag.get(tag, 0)
        if len(members) >= MIN_TAG_NOTES and len(members) + opened >= MIN_TAG_WEIGHT:
            add(tag_title(tag), "tag", f"тег #{tag}: заметок — {len(members)}, открытых задач — {opened}",
                members, tag=tag, weight=opened)

    folders: dict[str, set[str]] = {}                  # в) папка с несколькими заметками
    for f in notes:
        if free(f["path"]) and f.get("folder") and not f["path"].startswith(in_projects_dir):
            parts = f["folder"].split("/")
            for i in range(1, len(parts) + 1):
                folders.setdefault("/".join(parts[:i]), set()).add(f["path"])
    for folder, members in folders.items():
        name = folder.rsplit("/", 1)[-1]
        if len(members) < MIN_FOLDER_NOTES or name.lower() in SYSTEM_DIRS | GENERIC_DIRS or name.startswith("."):
            continue
        children = [d for d in folders if d.startswith(folder + "/")]
        if any(len(folders[d]) == len(members) for d in children):
            continue                                   # вся папка — это одна подпапка: кандидат — она
        if "/" not in folder and len(children) >= 2:
            continue                                   # «Ideas/» с разными подпапками — склад, а не проект
        add(name, "folder", f"папка {folder}/: заметок — {len(members)}", members, weight=1)

    for rel, sources in linked_by.items():             # г) узел, на который ссылаются несколько заметок
        src = {s for s in sources if free(s)}
        if free(rel) and len(src) >= MIN_HUB_LINKS:
            add(by_path[rel]["title"], "hub", f"на заметку ссылаются {len(src)} других", {rel, *src}, weight=1)

    candidates = []
    for c in cands.values():
        members = sorted(m for m in c["notes"] if m in by_path and m not in taken)
        if not members:
            continue
        opened = open_by_tag.get(c["tag"], 0)
        candidates.append({"name": c["name"], "tag": c["tag"], "kinds": c["kinds"], "reasons": c["reasons"],
                           "notes": members, "open_tasks": opened,
                           "score": len(members) + c["bonus"] + 2 * (len(c["kinds"]) - 1)})
    candidates.sort(key=lambda c: (-c["score"], c["name"].lower()))
    candidates = candidates[:limit]
    for c in candidates:
        for rel in c["notes"]:
            highlight.setdefault(rel, {"kind": "candidate", "project": c["name"]})
    return {"projects": out_projects, "candidates": candidates, "highlight": highlight}


def description(c: dict) -> str:
    """Текст новой заметки проекта из кандидата: откуда он взялся и ссылки на его заметки."""
    links = "\n".join(f"- [[{_noext(rel)}|{Path(rel).stem}]]" for rel in c["notes"][:30])
    return (f"Собран синтезом проектов: {'; '.join(c['reasons'])}.\n\n## Материалы\n{links}")
