"""Каталог приложений: свои программы владельца одним списком.

В каталоге — заметки с `type: app` (в любой папке) и проекты с полем `catalog: true`
(«＋ в каталог» на дашборде правит одну строку frontmatter). Поля: description — первая строка текста,
`url` — где открыть, `repo` — код, `icon` — эмодзи, `status`. То же — `core/apps.js`.
"""
from __future__ import annotations

from pathlib import Path

from .projects import STATUSES, Projects
from .vault import Vault, parse_frontmatter, set_frontmatter_field

YES = {"true", "yes", "да", "1", "on"}


def _s(meta: dict, key: str) -> str:
    v = meta.get(key)
    return "" if v is None or v is False or v == [] else str(v).strip()


def _desc(body: str) -> str:
    return next((ln.strip() for ln in body.splitlines()
                 if ln.strip() and not ln.lstrip().startswith(("#", "-", "|", ">", "!["))), "")[:200]


def catalog(vault: Vault, projects: Projects) -> dict:
    apps, seen = [], set()
    for p in projects.list():
        meta, body = parse_frontmatter(vault.read(p.note))
        if _s(meta, "catalog").lower() not in YES:
            continue
        seen.add(p.note)
        apps.append({"name": p.name, "note": p.note, "kind": "project", "description": p.description,
                     "status": p.status, "status_label": STATUSES.get(p.status, p.status), "repo": p.repo,
                     "url": p.url, "icon": _s(meta, "icon")})
    for rel in vault.list_files(""):
        if rel in seen:
            continue
        try:
            meta, body = parse_frontmatter(vault.read(rel))
        except OSError:
            continue
        if meta.get("type") != "app":
            continue
        status = _s(meta, "status") or "active"
        apps.append({"name": _s(meta, "name") or Path(rel).stem, "note": rel, "kind": "app",
                     "description": _s(meta, "description") or _desc(body), "status": status,
                     "status_label": STATUSES.get(status, status), "repo": _s(meta, "repo"), "url": _s(meta, "url"),
                     "icon": _s(meta, "icon")})
    apps.sort(key=lambda a: (a["status"] == "done", a["name"].lower()))
    names = {a["note"] for a in apps}
    available = [p.name for p in projects.list() if p.note not in names]
    return {"apps": apps, "available": available}


def set_in_catalog(vault: Vault, projects: Projects, name: str, on: bool) -> dict:
    p = projects.get_exact(name) or projects.get(name)
    if not p:
        raise ValueError(f"нет проекта «{name}»")
    vault.write(p.note, set_frontmatter_field(vault.read(p.note), "catalog", "true" if on else "false"))
    return catalog(vault, projects)
