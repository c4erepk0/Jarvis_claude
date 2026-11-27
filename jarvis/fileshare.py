"""Обмен файлами: папки Atom на своём сервере, без облака и внешних сервисов.

Зачем: владельцу нужно передавать операторам файлы (фото, договоры, выгрузки) и принимать их обратно.
Раньше это делал бы Google Drive, но тогда файлы уходят третьей стороне и зависят от её токенов.
Здесь всё лежит на машине, где работает Atom: `data/exchange/`.

Как устроено:
  data/exchange/<папка>/<файл>   — обычные папки и файлы; папка на диске = папка в приложении.
  Права — у оператора `files: [{path, name, level}]`: `view` — смотреть и скачивать,
  `upload` — ещё и класть файлы в эту папку (и подпапки).

Правила безопасности:
  - путь собирается только из нормальных сегментов: без `..`, абсолютных путей, скрытых имён и глубже
    шести уровней; итоговый путь обязан лежать внутри корня (проверка по `resolve()`);
  - имя файла чистится от `/ \\ : * ? " < > |` и управляющих символов, длина — до 120;
  - файл больше `max_mb` не принимается, общий объём — не больше `quota_mb`;
  - запись атомарная (временный файл + `os.replace`), поэтому оборванная загрузка не оставит половину;
  - отдать можно любой файл, но скачивается он как вложение (`Content-Disposition: attachment`), а не исполняется.

Здесь нет базы: список — это содержимое папки, размер — из файловой системы. Тесты — `tests/test_fileshare.py`.
"""
from __future__ import annotations

import mimetypes
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

MAX_DEPTH = 6
MAX_NAME = 120
LEVELS = {"view": "Просмотр", "upload": "Просмотр и загрузка"}
BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')
KINDS = {"image": "Фото", "video": "Видео", "audio": "Аудио", "text": "Текст", "pdf": "PDF", "file": "Файл"}
EXT_KINDS = {".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image", ".webp": "image", ".heic": "image",
             ".mp4": "video", ".mov": "video", ".m4v": "video", ".webm": "video",
             ".mp3": "audio", ".m4a": "audio", ".wav": "audio", ".ogg": "audio",
             ".pdf": "pdf", ".txt": "text", ".md": "text", ".csv": "text", ".json": "text", ".log": "text"}


class ShareError(ValueError):
    """Ошибка обмена файлами с текстом для человека. Наследник ValueError — веб отдаёт её как 400."""


def clean_name(name: str) -> str:
    """Имя файла или папки: без разделителей пути и служебных символов."""
    raw = (name or "").strip()
    # некоторые браузеры присылают имя в %XX
    if "%" in raw:
        try:
            from urllib.parse import unquote
            raw = unquote(raw)
        except (UnicodeDecodeError, ValueError):
            pass
    raw = raw.replace("\\", " ").strip()
    out = BAD_NAME.sub(" ", raw)
    out = re.sub(r"\s+\.", ".", out)                 # «итог .pdf» → «итог.pdf»
    out = re.sub(r"\s+", " ", out).strip(" .")
    out = out[:MAX_NAME]
    return out or ""


def kind_of(name: str, mime: str = "") -> str:
    ext = Path(name).suffix.lower()
    if ext in EXT_KINDS:
        return EXT_KINDS[ext]
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("video/"):
        return "video"
    if mime.startswith("audio/"):
        return "audio"
    if mime.startswith("text/"):
        return "text"
    return "file"


def fmt_size(size: int | None) -> str:
    if not size:
        return ""
    if size < 1024:
        return f"{size} Б"
    if size < 1024 * 1024:
        return f"{size / 1024:.0f} КБ"
    if size < 1024 * 1024 * 1024:
        return f"{size / 1024 / 1024:.1f} МБ"
    return f"{size / 1024 / 1024 / 1024:.1f} ГБ"


def mime_of(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def safe_for_download(name: str) -> str:
    """Имя для заголовка Content-Disposition: только ASCII-безопасное, иначе — запасное."""
    return re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip() or "file"


class FileShare:
    def __init__(self, root: Path, max_mb: int = 32, quota_mb: int = 2000):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max(1, int(max_mb)) * 1024 * 1024
        self.quota_bytes = max(1, int(quota_mb)) * 1024 * 1024

    # ---------- пути ----------
    def rel(self, value: str, *, allow_root: bool = False) -> str:
        """Нормализованный относительный путь внутри корня ('' — только если allow_root)."""
        source = (value or "").strip()
        if source.startswith(("/", "\\")):
            raise ShareError("путь должен быть относительным")
        raw = source.replace("\\", "/").strip("/")
        if not raw:
            if allow_root:
                return ""
            raise ShareError("не указана папка")
        parts = [p for p in raw.split("/") if p]
        if not parts or len(parts) > MAX_DEPTH:
            raise ShareError("слишком глубоко — не больше шести папок")
        for part in parts:
            if part in (".", "..") or part.startswith(".") or clean_name(part) != part:
                raise ShareError("недопустимое имя в пути")
        return "/".join(parts)

    def resolve(self, value: str, *, allow_root: bool = False) -> Path:
        """Путь на диске с проверкой, что он остался внутри корня."""
        rel = self.rel(value, allow_root=allow_root)
        path = self.root / rel if rel else self.root
        root = self.root.resolve()
        real = path.resolve()
        if real != root and root not in real.parents:
            raise ShareError("путь вне хранилища")
        return path

    def item(self, value: str) -> Path:
        """Существующий файл или папка по относительному пути."""
        path = self.resolve(value)
        if not path.exists():
            raise ShareError("файл или папка не найдены")
        return path

    def rel_of(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    @staticmethod
    def _modified(path: Path) -> str:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).astimezone().isoformat(timespec="minutes")

    def entry(self, path: Path) -> dict:
        rel = self.rel_of(path)
        if path.is_dir():
            return {"id": rel, "name": path.name, "kind": "folder", "mime": "", "size": None,
                    "size_label": "", "modified": self._modified(path)}
        size = path.stat().st_size
        mime = mime_of(path.name)
        return {"id": rel, "name": path.name, "kind": kind_of(path.name, mime), "mime": mime, "size": size,
                "size_label": fmt_size(size), "modified": self._modified(path)}

    # ---------- чтение ----------
    def list(self, folder: str = "") -> list[dict]:
        base = self.resolve(folder, allow_root=True)
        if not base.is_dir():
            raise ShareError("это не папка")
        items = []
        for path in base.iterdir():
            if path.name.startswith(".") or path.is_symlink():
                continue
            items.append(self.entry(path))
        return sorted(items, key=lambda x: (x["kind"] != "folder", x["name"].lower()))

    def read(self, value: str) -> tuple[bytes, str, str]:
        """Содержимое файла: (байты, mime, имя). Папку не читаем."""
        path = self.item(value)
        if not path.is_file():
            raise ShareError("это папка, а не файл")
        size = path.stat().st_size
        if size > self.max_bytes:
            raise ShareError(f"файл больше {fmt_size(self.max_bytes)} — скачайте его с сервера")
        return path.read_bytes(), mime_of(path.name), path.name

    def usage(self) -> dict:
        files = 0
        size = 0
        for path in self.root.rglob("*"):
            if path.is_file() and not path.is_symlink():
                files += 1
                size += path.stat().st_size
        return {"count": files, "bytes": size, "size_label": fmt_size(size),
                "quota": self.quota_bytes, "quota_label": fmt_size(self.quota_bytes),
                "max_mb": self.max_bytes // 1024 // 1024, "percent": min(100, round(size * 100 / self.quota_bytes))}

    # ---------- запись ----------
    def _unique(self, base: Path, name: str) -> Path:
        target = base / name
        if not target.exists():
            return target
        stem, ext = (name[: -len(Path(name).suffix)], Path(name).suffix) if Path(name).suffix else (name, "")
        n = 2
        while (base / f"{stem} ({n}){ext}").exists():
            n += 1
        return base / f"{stem} ({n}){ext}"

    def mkdir(self, name: str, parent: str = "") -> dict:
        folder = clean_name(name)
        if not folder:
            raise ShareError("назовите папку")
        base = self.resolve(parent, allow_root=True)
        if not base.is_dir():
            raise ShareError("это не папка")
        path = self._unique(base, folder)
        if len(self.rel_of(path).split("/")) > MAX_DEPTH:
            raise ShareError("слишком глубоко — не больше шести папок")
        path.mkdir()
        return self.entry(path)

    def save(self, name: str, data: bytes, mime: str = "", parent: str = "") -> dict:
        filename = clean_name(name)
        if not filename:
            raise ShareError("у файла нет имени")
        if not data:
            raise ShareError("файл пустой")
        if len(data) > self.max_bytes:
            raise ShareError(f"файл больше {fmt_size(self.max_bytes)}")
        used = self.usage()["bytes"]
        if used + len(data) > self.quota_bytes:
            raise ShareError(f"не хватает места: занято {fmt_size(used)} из {fmt_size(self.quota_bytes)}")
        base = self.resolve(parent, allow_root=True)
        if not base.is_dir():
            raise ShareError("это не папка")
        path = self._unique(base, filename)
        if len(self.rel_of(path).split("/")) > MAX_DEPTH:
            raise ShareError("слишком глубоко — не больше шести папок")
        fd, tmp = tempfile.mkstemp(prefix=".atom-", suffix=".part", dir=base)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return self.entry(path)

    def delete(self, value: str) -> dict:
        """Удалить файл или пустую папку (с содержимым — только явно)."""
        path = self.item(value)
        rel = self.rel_of(path)
        if path.is_dir():
            try:
                path.rmdir()
            except OSError:
                raise ShareError("папка не пуста — сначала удалите файлы в ней") from None
            return {"id": rel, "deleted": True}
        path.unlink()
        return {"id": rel, "deleted": True}

    def contains(self, value: str, roots: list[str]) -> bool:
        """Лежит ли элемент внутри одной из выданных папок (или совпадает с ней)."""
        try:
            rel = self.rel(value)
        except ShareError:
            return False
        for root in roots:
            if rel == root or rel.startswith(root + "/"):
                return True
        return False

    def disk_free(self) -> int:
        try:
            return shutil.disk_usage(self.root).free
        except OSError:
            return 0
