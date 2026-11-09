"""Хранилище Obsidian — долговременная память Jarvis.

Всё лежит обычными markdown-файлами: их можно читать и править в Obsidian на любом
устройстве, а синхронизацию делает Self-hosted LiveSync / Syncthing / iCloud (см. README).
Jarvis пишет атомарно (временный файл + rename), чтобы синхронизатор не подхватил
половину файла, и никогда не выходит за пределы папки хранилища.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

log = logging.getLogger("jarvis.vault")

IGNORED_DIRS = {".obsidian", ".trash", ".git", ".stfolder", ".stversions", ".sync", "node_modules"}
TEXT_EXT = {".md", ".txt", ".canvas", ".csv", ".json"}
WIKILINK = re.compile(r"\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]")
WORD = re.compile(r"[0-9a-zа-яё]+", re.IGNORECASE)


class VaultError(ValueError):
    """Недопустимый путь или операция с хранилищем."""


class VaultConflict(VaultError):
    """Заметку изменили (в Obsidian, синхронизацией) после того, как её открыли для правки."""

    def __init__(self, rel: str, current: str | None, message: str = ""):
        super().__init__(message or (f"заметку «{rel}» уже изменили — возможно, в Obsidian" if current is not None
                                     else f"заметки «{rel}» больше нет"))
        self.rel, self.current = rel, current


def content_version(text: str) -> str:
    """Версия содержимого: длина + FNV-1a (32 бита) от UTF-8. Так же считает core/vault.js —
    по ней редактор понимает, что заметку успели изменить, пока она была открыта."""
    data = text.encode("utf-8")
    h = 0x811C9DC5
    for b in data:
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return f"{len(data)}-{h:08x}"


# ---------- frontmatter (минимальное подмножество YAML, без зависимостей) ----------

def _parse_scalar(raw: str) -> Any:
    v = raw.strip()
    if not v:
        return ""
    if (v[0] == v[-1]) and v[0] in "\"'" and len(v) >= 2:
        return v[1:-1]
    if v.startswith("[") and v.endswith("]"):
        inner = v[1:-1].strip()
        return [_parse_scalar(x) for x in inner.split(",")] if inner else []
    low = v.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if low in ("null", "~"):
        return None
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    if re.fullmatch(r"-?\d+\.\d+", v):
        return float(v)
    return v


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Возвращает (метаданные, тело). Понимает `key: value`, `[a, b]` и списки `- x`."""
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines(keepends=True)
    if lines[0].strip() != "---":
        return {}, text
    meta: dict[str, Any] = {}
    key: str | None = None
    for i in range(1, len(lines)):
        line = lines[i].rstrip("\r\n")
        if line.strip() == "---":
            return meta, "".join(lines[i + 1:])
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^\s+-\s*(.*)$", line)
        if m and key is not None:
            if not isinstance(meta.get(key), list):
                meta[key] = []
            meta[key].append(_parse_scalar(m.group(1)))
            continue
        m = re.match(r"^([^:\s][^:]*):\s*(.*)$", line)
        if m:
            key = m.group(1).strip()
            meta[key] = _parse_scalar(m.group(2)) if m.group(2).strip() else []
    return {}, text  # нет закрывающего ---


def dump_frontmatter(meta: dict[str, Any]) -> str:
    def fmt(v: Any) -> str:
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (list, tuple)):
            return "[" + ", ".join(fmt(x) for x in v) + "]"
        s = "" if v is None else str(v)
        return f'"{s}"' if (":" in s or s.startswith(("[", "{", "#", "-"))) else s
    body = "\n".join(f"{k}: {fmt(v)}" for k, v in meta.items())
    return f"---\n{body}\n---\n"


RU_ENDINGS = re.compile(r"(иями|ями|ами|ого|его|ому|ему|ыми|ими|ов|ев|ей|ам|ям|ах|ях|ою|ею|ой|ий|ый|ая|яя|ое|ее|"
                        r"ые|ие|ую|юю|ом|ем|а|я|о|е|ы|и|у|ю|ь)$")


def stem(word: str) -> str:
    """Грубая «основа» слова: хватает, чтобы «оферту» нашлась по «оферта», а «задачи» — по «задача»."""
    w = word.lower().replace("ё", "е")
    if len(w) > 4 and re.search(r"[а-я]", w):
        w = RU_ENDINGS.sub("", w) or w
    return w[:6] if len(w) > 6 else w


def tokens(text: str) -> list[str]:
    return [stem(w) for w in WORD.findall(text) if len(w) > 1]


@dataclass
class SearchHit:
    path: str
    title: str
    score: float
    snippet: str

    def as_dict(self) -> dict:
        return {"path": self.path, "title": self.title, "score": round(self.score, 2), "snippet": self.snippet}


class Vault:
    def __init__(self, root: Path):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._listeners: list[Callable[[list[str]], Awaitable[None]]] = []
        self._snapshot: dict[str, tuple[int, int]] = {}
        self.version = 0  # растёт при каждом изменении — по нему сбрасываются кэши

    # ---------- пути ----------
    def resolve(self, rel: str, *, for_write: bool = False) -> Path:
        rel = (rel or "").replace("\\", "/").strip().lstrip("/")
        if not rel or "\x00" in rel:
            raise VaultError("пустой путь")
        parts = Path(rel).parts
        if any(p in ("..", "") for p in parts) or (parts and parts[0] in IGNORED_DIRS):
            raise VaultError(f"недопустимый путь: {rel}")
        path = (self.root / rel).resolve()
        if path != self.root and self.root not in path.parents:
            raise VaultError(f"путь вне хранилища: {rel}")
        if for_write and path.suffix.lower() not in TEXT_EXT:
            raise VaultError("писать можно только текстовые заметки (.md, .txt, .canvas, .csv, .json)")
        return path

    def rel(self, path: Path) -> str:
        return path.resolve().relative_to(self.root).as_posix()

    # ---------- чтение / запись ----------
    def exists(self, rel: str) -> bool:
        try:
            return self.resolve(rel).is_file()
        except VaultError:
            return False

    def read(self, rel: str, default: str | None = None) -> str:
        path = self.resolve(rel)
        if not path.is_file():
            if default is not None:
                return default
            raise FileNotFoundError(rel)
        return path.read_text(encoding="utf-8", errors="replace")

    def write(self, rel: str, text: str) -> str:
        path = self.resolve(rel, for_write=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".jarvis-", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self.version += 1
        return self.rel(path)

    def append(self, rel: str, text: str, *, header: str = "") -> str:
        """Дописывает текст в конец заметки (создаёт её с заголовком, если нет)."""
        current = self.read(rel, default="") if self.exists(rel) else header
        if current and not current.endswith("\n"):
            current += "\n"
        return self.write(rel, current + text.rstrip("\n") + "\n")

    def append_to_section(self, rel: str, section: str, line: str, *, header: str = "") -> str:
        """Дописывает строку в конец раздела `## section` (создаёт раздел при необходимости)."""
        text = self.read(rel, default="") if self.exists(rel) else header
        lines = text.splitlines()
        title = f"## {section}"
        try:
            start = next(i for i, ln in enumerate(lines) if ln.strip().lower() == title.lower())
        except StopIteration:
            if lines and lines[-1].strip():
                lines.append("")
            lines += [title, line]
            return self.write(rel, "\n".join(lines) + "\n")
        end = start + 1
        while end < len(lines) and not re.match(r"^#{1,2} ", lines[end]):
            end += 1
        insert = end
        while insert > start + 1 and not lines[insert - 1].strip():
            insert -= 1
        lines.insert(insert, line)
        return self.write(rel, "\n".join(lines) + "\n")

    def note(self, rel: str) -> tuple[dict[str, Any], str]:
        return parse_frontmatter(self.read(rel))

    def save(self, rel: str, text: str, base: str | None) -> str:
        """Сохранить правку из редактора. base — версия, с которой начали править (content_version);
        None — создать новую заметку. Если заметку с тех пор изменили или она уже есть — VaultConflict,
        ничего не записано: правки владельца в Obsidian не затираются."""
        current = self.read(rel) if self.exists(rel) else None
        if base is None:
            if current is not None:
                raise VaultConflict(rel, current, f"заметка «{rel}» уже есть")
        elif current is None or content_version(current) != base:
            raise VaultConflict(rel, current)
        return self.write(rel, text)

    def find_note(self, query: str) -> str | None:
        """Заметка по пути, названию или словам: «IPAStore», «Projects/IPAStore.md», «оферта»."""
        q = (query or "").strip().strip("«»\"'").strip()
        if not q:
            return None
        for cand in (q, q + ".md"):
            if self.exists(cand):
                return self.resolve(cand).relative_to(self.root).as_posix()
        files = self.list_files()
        low = q.lower().replace("ё", "е")
        by_title = [f for f in files if self.title_of(f).lower().replace("ё", "е") == low]
        if by_title:
            return by_title[0]
        partial = [f for f in files if low in self.title_of(f).lower().replace("ё", "е")]
        if partial:
            return min(partial, key=len)
        hits = self.search(q, 1)
        return hits[0].path if hits else None

    # ---------- обход ----------
    def list_files(self, folder: str = "", exts: set[str] | None = None) -> list[str]:
        base = self.resolve(folder) if folder else self.root
        if not base.is_dir():
            return []
        exts = exts or {".md"}
        out: list[str] = []
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS and not d.startswith(".")]
            for name in filenames:
                if name.startswith(".jarvis-"):
                    continue
                if os.path.splitext(name)[1].lower() in exts:
                    out.append(Path(dirpath, name).relative_to(self.root).as_posix())
        return sorted(out)

    @staticmethod
    def title_of(rel: str) -> str:
        return Path(rel).stem

    # ---------- поиск ----------
    def search(self, query: str, limit: int = 8, folder: str = "") -> list[SearchHit]:
        q = [t for t in tokens(query)]
        if not q:
            return []
        hits: list[SearchHit] = []
        for rel in self.list_files(folder):
            try:
                text = self.read(rel)
            except OSError:
                continue
            title = self.title_of(rel)
            title_t, body_t = tokens(title), tokens(text)
            if not body_t and not title_t:
                continue
            score = 0.0
            for term in set(q):
                score += 3.0 * title_t.count(term) + min(body_t.count(term), 10) * (1.0 / (1 + len(body_t) / 400))
            matched = sum(1 for term in set(q) if term in title_t or term in body_t)
            if not matched:
                continue
            score *= matched / len(set(q))
            hits.append(SearchHit(rel, title, score, self._snippet(text, q)))
        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:limit]

    @staticmethod
    def _snippet(text: str, q: list[str], width: int = 180) -> str:
        _, body = parse_frontmatter(text)
        flat = re.sub(r"\s+", " ", body).strip()
        low = flat.lower().replace("ё", "е")
        pos = min((p for p in (low.find(t) for t in q) if p >= 0), default=0)
        start = max(0, pos - width // 3)
        chunk = flat[start:start + width]
        return ("…" if start else "") + chunk + ("…" if start + width < len(flat) else "")

    # ---------- граф заметок (для голограммы) ----------
    def graph(self, limit: int = 600) -> dict:
        files = self.list_files()[:limit]
        by_title = {self.title_of(f).lower(): f for f in files}
        nodes, links = [], []
        for rel in files:
            try:
                text = self.read(rel)
            except OSError:
                continue
            meta, _ = parse_frontmatter(text)
            group = rel.split("/", 1)[0] if "/" in rel else "root"
            nodes.append({"id": rel, "title": self.title_of(rel), "group": group,
                          "type": str(meta.get("type", "")), "size": len(text)})
            for target in WIKILINK.findall(text):
                dst = by_title.get(Path(target.strip()).stem.lower())
                if dst and dst != rel:
                    links.append({"source": rel, "target": dst})
        return {"nodes": nodes, "links": links}

    # ---------- наблюдение за изменениями (синхронизация в реальном времени) ----------
    def subscribe(self, callback: Callable[[list[str]], Awaitable[None]]) -> None:
        self._listeners.append(callback)

    def scan(self) -> dict[str, tuple[int, int]]:
        snap: dict[str, tuple[int, int]] = {}
        for rel in self.list_files(exts=TEXT_EXT):
            try:
                st = (self.root / rel).stat()
            except OSError:
                continue
            snap[rel] = (st.st_mtime_ns, st.st_size)
        return snap

    def diff(self) -> list[str]:
        """Сравнивает с прошлым снимком и возвращает изменённые/новые/удалённые пути."""
        new = self.scan()
        changed = [p for p, sig in new.items() if self._snapshot.get(p) != sig]
        changed += [p for p in self._snapshot if p not in new]
        self._snapshot = new
        if changed:
            self.version += 1
        return sorted(changed)

    async def watch(self, interval: float = 1.5) -> None:
        loop = asyncio.get_running_loop()
        self._snapshot = await loop.run_in_executor(None, self.scan)
        while True:
            await asyncio.sleep(interval)
            try:
                changed = await loop.run_in_executor(None, self.diff)
            except Exception:  # noqa: BLE001 — сторож не должен падать
                log.exception("ошибка при сканировании хранилища")
                continue
            if not changed:
                continue
            for cb in list(self._listeners):
                try:
                    await cb(changed)
                except Exception:  # noqa: BLE001
                    log.exception("ошибка обработчика изменений хранилища")
