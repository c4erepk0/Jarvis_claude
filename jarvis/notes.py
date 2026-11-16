"""Менеджер заметок: дерево хранилища, теги, обратные ссылки, шаблоны, переименование и перемещение
с правкой [[ссылок]], корзина. То же самое — в `webapp/static/core/notes.js` (ядро для iPhone).

Правила как в Obsidian, чтобы хранилище оставалось «своим» для него:
- удалённое уходит в `.trash/` (корзина Obsidian), а не стирается;
- при переименовании заметки ссылки `[[Старое]]`, `[[Папка/Старое|подпись]]`, `[[Старое#раздел]]`
  во всех заметках меняются на новое название (подпись и раздел сохраняются);
- шаблоны — заметки из `Templates/`, подстановки `{{title}}`, `{{date}}`, `{{time}}` (как в плагине «Шаблоны»).
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any

from .tasks import TAG
from .vault import TEXT_EXT, Vault, VaultError, parse_frontmatter

INLINE_CODE = re.compile(r"`[^`]*`")
LINK = re.compile(r"\[\[([^\]|#^]+)([#^][^\]|]*)?(\|[^\]]*)?\]\]")
TEMPLATES = "Templates"
NOTE_EXT = (".md", ".txt")


def note_tags(text: str) -> list[str]:
    """Теги заметки: поле `tags` во frontmatter и #теги в тексте (вне блоков кода), строчными, без повторов."""
    meta, body = parse_frontmatter(text)
    raw = meta.get("tags") or meta.get("tag") or []
    found = [str(t).lstrip("#") for t in (raw if isinstance(raw, list) else str(raw).replace(",", " ").split())]
    in_code = False
    for line in body.splitlines():
        if line.lstrip().startswith("```"):
            in_code = not in_code
            continue
        if not in_code:
            found += TAG.findall(INLINE_CODE.sub(" ", line))
    out: list[str] = []
    for t in found:
        t = t.strip().lower()
        if t and not t.isdigit() and t not in out:
            out.append(t)
    return out


def link_targets(text: str) -> list[str]:
    return [m.group(1).strip() for m in LINK.finditer(text)]


def _noext(rel: str) -> str:
    return rel[: -len(Path(rel).suffix)] if Path(rel).suffix else rel


def rewrite_links(text: str, old: str, new: str) -> str:
    """Ссылки на заметку old (путь) переписываются на new: [[Старое]] → [[Новое]], [[Папка/Старое]] →
    [[НоваяПапка/Новое]]; раздел (#…) и подпись (|…) остаются как были."""
    old_title, old_path = Path(old).stem.lower(), _noext(old).lower()
    new_title, new_path = Path(new).stem, _noext(new)

    def sub(m: re.Match) -> str:
        target = m.group(1).strip()
        low = _noext(target).lower() if Path(target).suffix.lower() in TEXT_EXT else target.lower()
        if "/" in target:
            if low != old_path:
                return m.group(0)
            repl = new_path
        else:
            if low != old_title:
                return m.group(0)
            repl = new_title
        return f"[[{repl}{m.group(2) or ''}{m.group(3) or ''}]]"
    return LINK.sub(sub, text)


def fill_template(text: str, title: str, when: datetime) -> str:
    return (text.replace("{{title}}", title).replace("{{date}}", when.date().isoformat())
            .replace("{{time}}", f"{when:%H:%M}"))


class Notes:
    def __init__(self, vault: Vault, *, templates: str = TEMPLATES):
        self.vault = vault
        self.templates = templates.strip("/")
        self._index: tuple[int, dict] | None = None

    # ---------- обзор ----------
    def index(self) -> dict:
        """Всё хранилище одним ответом: файлы (с тегами и типом), папки (и пустые), шаблоны, теги со счётчиком."""
        if self._index and self._index[0] == self.vault.version:
            return self._index[1]
        files: list[dict[str, Any]] = []
        counts: dict[str, int] = {}
        for rel in self.vault.list_files(exts=set(TEXT_EXT)):
            try:
                path = self.vault.root / rel
                st = path.stat()
                text = self.vault.read(rel) if rel.endswith(NOTE_EXT) else ""
            except OSError:
                continue
            meta, _ = parse_frontmatter(text)
            tags = note_tags(text) if text else []
            for t in tags:
                counts[t] = counts.get(t, 0) + 1
            files.append({"path": rel, "title": Path(rel).stem, "folder": rel.rsplit("/", 1)[0] if "/" in rel else "",
                          "ext": Path(rel).suffix.lower(), "size": st.st_size, "mtime": int(st.st_mtime),
                          "tags": tags, "type": str(meta.get("type") or ""),
                          "links": link_targets(text) if text else []})
        folders = sorted(self.vault.list_dirs())
        templates = [f["path"] for f in files if f["path"].startswith(self.templates + "/") and f["ext"] == ".md"]
        res = {"files": files, "folders": folders, "templates": templates,
               "tags": [{"tag": t, "count": n} for t, n in sorted(counts.items(), key=lambda x: (-x[1], x[0]))]}
        self._index = (self.vault.version, res)
        return res

    def backlinks(self, rel: str) -> list[dict]:
        """Заметки со ссылкой [[…]] на эту."""
        title, path = Path(rel).stem.lower(), _noext(rel).lower()
        out = []
        for other in self.vault.list_files():
            if other == rel:
                continue
            try:
                text = self.vault.read(other)
            except OSError:
                continue
            for t in link_targets(text):
                low = _noext(t).lower() if t.lower().endswith(".md") else t.lower()
                if low == (path if "/" in t else title):
                    out.append({"path": other, "title": Path(other).stem})
                    break
        return out

    def outlinks(self, rel: str) -> list[dict]:
        """Заметки, на которые ссылается эта ([[…]] в её тексте), — без несуществующих и без повторов."""
        titles: dict[str, str] = {}
        for f in self.index()["files"]:
            titles.setdefault(f["title"].lower(), f["path"])
            titles.setdefault(_noext(f["path"]).lower(), f["path"])
        out: list[dict] = []
        for t in link_targets(self.vault.read(rel, "")):
            low = _noext(t).lower() if Path(t).suffix.lower() in TEXT_EXT else t.lower()
            dst = titles.get(low) or titles.get(low.rsplit("/", 1)[-1])
            if dst and dst != rel and all(o["path"] != dst for o in out):
                out.append({"path": dst, "title": Path(dst).stem})
        return out

    # ---------- изменения ----------
    def create(self, rel: str, *, template: str | None = None, when: datetime, content: str | None = None) -> str:
        """Новая заметка (по шаблону или с заголовком). Если такая есть — ошибка, ничего не затирается."""
        rel = (rel or "").strip().strip("/")
        if not rel:
            raise VaultError("введите название заметки")
        if not Path(rel).suffix:
            rel += ".md"
        if Path(rel).suffix.lower() not in NOTE_EXT:
            raise VaultError("создавать можно заметки .md и .txt")
        if self.vault.exists(rel):
            raise VaultError(f"заметка «{rel}» уже есть")
        title = Path(rel).stem
        if content is None:
            if template:
                content = fill_template(self.vault.read(template), title, when)
            else:
                content = f"# {title}\n\n"
        return self.vault.write(rel, content)

    def mkdir(self, rel: str) -> str:
        return self.vault.mkdir(rel)

    def move(self, src: str, dst: str) -> dict:
        """Переименовать или переместить заметку либо папку; ссылки на перемещённые заметки правятся везде."""
        src, dst = src.strip().strip("/"), dst.strip().strip("/")
        is_dir = self.vault.is_dir(src)
        if not is_dir and Path(dst).suffix.lower() != Path(src).suffix.lower():
            dst += Path(src).suffix          # «Новое имя» без расширения — расширение прежнее
        if src == dst:
            return {"path": dst, "updated": []}
        moved = self.vault.move(src, dst)    # [(старый путь, новый путь)] — для папки все её заметки
        updated: list[str] = []
        renames = [(a, b) for a, b in moved if a.endswith(".md")]
        if renames:
            for rel in self.vault.list_files():
                try:
                    text = self.vault.read(rel)
                except OSError:
                    continue
                new_text = text
                for a, b in renames:
                    new_text = rewrite_links(new_text, a, b)
                if new_text != text:
                    self.vault.write(rel, new_text)
                    updated.append(rel)
        return {"path": dst, "moved": len(moved), "updated": updated}

    def trash(self, rel: str) -> dict:
        """В корзину Obsidian (`.trash/`) — восстановить можно из Obsidian или перетащив файл обратно."""
        return {"path": rel, "trash": self.vault.trash(rel)}
