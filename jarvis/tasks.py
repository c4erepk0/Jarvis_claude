"""Задачи в формате плагина Obsidian Tasks: `- [ ] Текст ⏫ 📅 2026-11-10 #ipastore`.

Задачи собираются со всего хранилища, поэтому их можно писать в любой заметке —
в проекте, в дневнике, во входящих. Jarvis добавляет новые во «входящие» или в заметку проекта.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta

from .vault import Vault

TASK_LINE = re.compile(r"^(\s*)[-*+] \[(.)\] (.*)$")
DATE_RX = r"(\d{4}-\d{2}-\d{2})"
SIGNS = {"due": "📅", "scheduled": "⏳", "start": "🛫", "created": "➕", "done": "✅", "cancelled": "❌"}
PRIORITY = {"🔺": 5, "⏫": 4, "🔼": 3, "🔽": 1, "⏬": 0}
PRIORITY_BY_NAME = {"highest": "🔺", "high": "⏫", "medium": "🔼", "low": "🔽", "lowest": "⏬"}
TAG = re.compile(r"(?<![\w/])#([\w][\w/\-]*)", re.UNICODE)
SKIP_FOLDERS = ("Templates/", "Шаблоны/")


@dataclass
class Task:
    id: str
    path: str
    line: int
    text: str
    status: str               # todo | doing | done | cancelled
    priority: int = 2         # 0..5, 2 — обычная
    due: str | None = None
    scheduled: str | None = None
    created: str | None = None
    done: str | None = None
    tags: list[str] = field(default_factory=list)
    raw: str = ""

    @property
    def is_open(self) -> bool:
        return self.status in ("todo", "doing")

    def as_dict(self) -> dict:
        d = asdict(self)
        d.pop("raw", None)
        return d


def _line_hash(line: str) -> str:
    return hashlib.sha1(line.strip().encode()).hexdigest()[:8]


def parse_line(path: str, lineno: int, line: str) -> Task | None:
    m = TASK_LINE.match(line)
    if not m:
        return None
    mark, body = m.group(2), m.group(3)
    status = {" ": "todo", "/": "doing", "x": "done", "X": "done", "-": "cancelled"}.get(mark)
    if status is None:
        return None
    dates: dict[str, str | None] = {}
    for key, sign in SIGNS.items():
        dm = re.search(re.escape(sign) + r"\s*" + DATE_RX, body)
        dates[key] = dm.group(1) if dm else None
    prio = 2
    for sign, value in PRIORITY.items():
        if sign in body:
            prio = value
            break
    tags = [t.lower() for t in TAG.findall(body)]
    text = body
    for sign in SIGNS.values():
        text = re.sub(re.escape(sign) + r"\s*" + DATE_RX, "", text)
    text = re.sub(r"🔁[^📅⏳🛫➕✅❌]*", "", text)
    for sign in PRIORITY:
        text = text.replace(sign, "")
    text = re.sub(r"\s{2,}", " ", text).strip()
    text = re.sub(r"(?:\s+#[\w][\w/\-]*)+$", "", text, flags=re.UNICODE).strip() or text
    return Task(id=f"{path}:{lineno}:{_line_hash(line)}", path=path, line=lineno, text=text, status=status,
                priority=prio, due=dates["due"], scheduled=dates["scheduled"], created=dates["created"],
                done=dates["done"], tags=tags, raw=line)


def format_task(text: str, *, due: date | None = None, priority: str | None = None,
                tags: list[str] | None = None, created: date | None = None) -> str:
    parts = [text.strip()]
    for tag in tags or []:
        tag = tag.lstrip("#").strip()
        if tag and f"#{tag}".lower() not in text.lower():
            parts.append(f"#{tag}")
    if priority and priority in PRIORITY_BY_NAME:
        parts.append(PRIORITY_BY_NAME[priority])
    if created:
        parts.append(f"➕ {created.isoformat()}")
    if due:
        parts.append(f"📅 {due.isoformat()}")
    return "- [ ] " + " ".join(parts)


class TaskBook:
    def __init__(self, vault: Vault, inbox: str, skip: tuple[str, ...] = ()):
        self.vault = vault
        self.inbox = inbox
        self.skip = SKIP_FOLDERS + tuple(skip)
        self._cache: tuple[int, list[Task]] | None = None

    def all(self) -> list[Task]:
        if self._cache and self._cache[0] == self.vault.version:
            return self._cache[1]
        out: list[Task] = []
        for rel in self.vault.list_files():
            if rel.startswith(self.skip):
                continue
            try:
                lines = self.vault.read(rel).splitlines()
            except OSError:
                continue
            in_code = False
            for i, line in enumerate(lines):
                if line.lstrip().startswith("```"):
                    in_code = not in_code
                    continue
                if in_code:
                    continue
                t = parse_line(rel, i, line)
                if t:
                    out.append(t)
        self._cache = (self.vault.version, out)
        return out

    def get(self, task_id: str) -> Task | None:
        return next((t for t in self.all() if t.id == task_id), None)

    # ---------- представления ----------
    def view(self, ref: date, name: str = "today", tag: str | None = None) -> list[Task]:
        tasks = [t for t in self.all() if t.is_open]
        if tag:
            tag = tag.lower().lstrip("#")
            tasks = [t for t in tasks if any(x == tag or x.startswith(tag + "/") for x in t.tags)]
        iso = ref.isoformat()
        week = (ref + timedelta(days=7)).isoformat()
        if name == "today":
            tasks = [t for t in tasks if (t.due and t.due <= iso) or (t.scheduled and t.scheduled <= iso)
                     or t.status == "doing"]
        elif name == "overdue":
            tasks = [t for t in tasks if t.due and t.due < iso]
        elif name == "week":
            tasks = [t for t in tasks if t.due and t.due <= week]
        elif name == "nodate":
            tasks = [t for t in tasks if not t.due and not t.scheduled]
        return sorted(tasks, key=lambda t: (t.due or "9999", -t.priority, t.path, t.line))

    def done_on(self, day: date) -> list[Task]:
        return [t for t in self.all() if t.status == "done" and t.done == day.isoformat()]

    def summary(self, ref: date) -> dict:
        open_ = [t for t in self.all() if t.is_open]
        iso = ref.isoformat()
        return {
            "open": len(open_),
            "today": len(self.view(ref, "today")),
            "overdue": sum(1 for t in open_ if t.due and t.due < iso),
            "done_today": len(self.done_on(ref)),
        }

    # ---------- изменения ----------
    def add(self, text: str, ref: date, *, due: date | None = None, priority: str | None = None,
            tags: list[str] | None = None, note: str | None = None) -> Task:
        text = text.strip()
        if not text:
            raise ValueError("пустая задача")
        line = format_task(text, due=due, priority=priority, tags=tags, created=ref)
        target = note or self.inbox
        if note:
            self.vault.append_to_section(target, "Задачи", line)
        else:
            self.vault.append(target, line, header="# Входящие задачи\n\n")
        lines = self.vault.read(target).splitlines()
        idx = max(i for i, ln in enumerate(lines) if ln == line)
        task = parse_line(self.vault.rel(self.vault.resolve(target)), idx, line)
        assert task is not None
        return task

    def _locate(self, task_id: str) -> tuple[str, list[str], int]:
        try:
            path, lineno, digest = task_id.rsplit(":", 2)
            lineno_i = int(lineno)
        except ValueError as e:
            raise KeyError("неверный id задачи") from e
        lines = self.vault.read(path).splitlines()
        if 0 <= lineno_i < len(lines) and _line_hash(lines[lineno_i]) == digest:
            return path, lines, lineno_i
        # файл менялся (например, на телефоне) — ищем ту же строку
        for i, ln in enumerate(lines):
            if TASK_LINE.match(ln) and _line_hash(ln) == digest:
                return path, lines, i
        raise KeyError("задача не найдена — возможно, её уже изменили")

    def set_status(self, task_id: str, status: str, ref: date) -> Task:
        path, lines, i = self._locate(task_id)
        m = TASK_LINE.match(lines[i])
        assert m
        mark = {"todo": " ", "doing": "/", "done": "x", "cancelled": "-"}[status]
        body = re.sub(r"\s*[✅❌]\s*" + DATE_RX, "", m.group(3))
        if status == "done":
            body += f" ✅ {ref.isoformat()}"
        elif status == "cancelled":
            body += f" ❌ {ref.isoformat()}"
        lines[i] = f"{m.group(1)}- [{mark}] {body}"
        self.vault.write(path, "\n".join(lines) + "\n")
        task = parse_line(path, i, lines[i])
        assert task
        return task

    def complete(self, task_id: str, ref: date) -> Task:
        return self.set_status(task_id, "done", ref)

    def find(self, query: str) -> list[Task]:
        q = query.lower().strip()
        if not q:
            return []
        words = [w for w in re.findall(r"\w+", q) if len(w) > 2]
        open_ = [t for t in self.all() if t.is_open]
        exact = [t for t in open_ if q in t.text.lower()]
        if exact:
            return exact
        return [t for t in open_ if words and all(w[:5] in t.text.lower() for w in words)]

    def archive_done(self, ref: date, older_than_days: int = 7, archive: str = "Tasks/Archive.md") -> int:
        """Протокол «Чистый лист»: переносит старые выполненные задачи из входящих в архив."""
        if not self.vault.exists(self.inbox):
            return 0
        border = (ref - timedelta(days=older_than_days)).isoformat()
        keep, moved = [], []
        for i, line in enumerate(self.vault.read(self.inbox).splitlines()):
            t = parse_line(self.inbox, i, line)
            if t and t.status in ("done", "cancelled") and (t.done or t.created or "0000") <= border:
                moved.append(line)
            else:
                keep.append(line)
        if moved:
            self.vault.append(archive, "\n".join(moved), header="# Архив задач\n\n")
            self.vault.write(self.inbox, "\n".join(keep) + "\n")
        return len(moved)
