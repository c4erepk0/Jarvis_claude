"""Коннектор Google Drive: владелец связывает Диск с Atom, отмечает файлы операторам.

Зачем: у владельца часть материалов живёт не в хранилище Obsidian, а на Google Drive (договоры, таблицы,
выгрузки). Коннектор даёт Atom читать их, а в окне «Команда» владелец отмечает, что и кому из операторов
можно смотреть.

Три правила, на которых всё держится:

1. **Только чтение.** Права OAuth — `drive.readonly`. Коннектор не пишет на Диск, не удаляет и не меняет
   доступы; ошибка в коде не может испортить чужие файлы.
2. **Анонимность ядра.** Наружу (в интерфейс и API оператора) уходят только поля `id/name/mime/kind/size/
   modified`. Владельцы файла, права, почта аккаунта, родительские папки и ссылки `webViewLink` не покидают
   модуль: `_item()` собирает ответ по белому списку, а не вырезает лишнее из ответа Google. Оператор видит
   «Диск ядра», а не чей это Диск.
3. **Доступ — по одному файлу.** Оператор получает ровно те файлы, которые владелец отметил в «Команде»;
   папки не выдаются (иначе выдача папки открыла бы всё, что в неё положат позже).

Настройка (`.env`): `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`, по желанию
`GDRIVE_FOLDER_ID` (ограничить одной папкой) и `GDRIVE_MAX_MB`. Инструкция — `docs/drive.md`.

Транспорт внедряется (`transport=`), поэтому тесты идут без сети и без токена: `tests/test_gdrive.py`.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import aiohttp

TOKEN_URL = "https://oauth2.googleapis.com/token"
FILES_URL = "https://www.googleapis.com/drive/v3/files"

FOLDER_MIME = "application/vnd.google-apps.folder"
DOC_MIME = "application/vnd.google-apps.document"
SHEET_MIME = "application/vnd.google-apps.spreadsheet"
SLIDES_MIME = "application/vnd.google-apps.presentation"

# Уровни доступа оператора к файлу Диска: смотреть и (по желанию) сохранить копию в свою папку.
LEVELS = {"view": "Просмотр", "copy": "Просмотр и копия к себе"}

KINDS = {DOC_MIME: "doc", SHEET_MIME: "sheet", SLIDES_MIME: "slides", FOLDER_MIME: "folder"}
KIND_LABELS = {"doc": "Документ", "sheet": "Таблица", "slides": "Презентация", "folder": "Папка", "text": "Текст",
               "file": "Файл"}
MAX_TEXT = 4 * 1024 * 1024          # больше в заметку не тянем: это не хранилище файлов
MAX_FILES = 100
ID_RE = re.compile(r"^[A-Za-z0-9_-]{5,200}$")
SAFE_NAME = re.compile(r"[\\/:*?\"<>|\n\r\t]+")

# transport(method, url, params, data, headers) -> (status, body_bytes, content_type)
Transport = Callable[[str, str, "dict[str, Any] | None", "dict[str, str] | None", "dict[str, str]"],
                     Awaitable[tuple[int, bytes, str]]]


class DriveError(ValueError):
    """Ошибка коннектора с текстом для человека. Наследник ValueError — веб-сервер отдаёт её как 400."""


@dataclass(frozen=True)
class DriveConfig:
    enabled: bool = True
    client_id: str = ""
    client_secret: str = ""
    refresh_token: str = ""
    folder_id: str = ""
    max_mb: int = 4

    @property
    def ready(self) -> bool:
        return bool(self.enabled and self.client_id and self.client_secret and self.refresh_token)


async def _aiohttp_transport(method: str, url: str, params: dict | None, data: dict | None,
                             headers: dict[str, str], timeout: float = 25.0) -> tuple[int, bytes, str]:
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
        async with session.request(method, url, params=params, data=data, headers=headers) as resp:
            return resp.status, await resp.read(), resp.headers.get("Content-Type", "")


def kind_of(mime: str) -> str:
    if mime in KINDS:
        return KINDS[mime]
    if mime.startswith("text/") or mime in ("application/json", "application/xml"):
        return "text"
    return "file"


def safe_name(name: str) -> str:
    """Имя файла, которое безопасно положить заметкой: без слэшей, служебных символов и двойных пробелов."""
    out = SAFE_NAME.sub(" ", (name or "").strip())
    for suffix in (".md", ".markdown", ".txt"):
        if out.lower().endswith(suffix):
            out = out[: -len(suffix)]
    out = re.sub(r"\s+", " ", out).strip(" .")
    return (out or "Документ")[:80]


def fmt_size(size: int | None) -> str:
    if not size:
        return ""
    if size < 1024:
        return f"{size} Б"
    if size < 1024 * 1024:
        return f"{size / 1024:.0f} КБ"
    return f"{size / 1024 / 1024:.1f} МБ"


def render_note(name: str, text: str, day: str) -> str:
    """Заметка из файла Диска. Ничего о владельце аккаунта сюда не попадает — только источник."""
    body = (text or "").strip() or "Пустой документ."
    head = f"---\ntype: drive\nsource: Диск ядра\nimported: {day}\n---\n# {safe_name(name)}\n\n"
    return head + body + "\n"


class Drive:
    """Чтение Google Drive по refresh-токену. Один экземпляр на Jarvis."""

    def __init__(self, cfg: DriveConfig, *, transport: Transport | None = None, timeout: float = 25.0):
        self.cfg = cfg
        self._transport = transport
        self.timeout = timeout
        self._token: str = ""
        self._expires: float = 0.0
        self._lock = asyncio.Lock()

    # ---------- состояние ----------
    @property
    def ready(self) -> bool:
        return self.cfg.ready

    def status(self) -> dict:
        """Для админ-панели: подключено ли, куда смотрим. Без запросов в сеть и без имени аккаунта."""
        missing = [n for n, v in (("GDRIVE_CLIENT_ID", self.cfg.client_id),
                                  ("GDRIVE_CLIENT_SECRET", self.cfg.client_secret),
                                  ("GDRIVE_REFRESH_TOKEN", self.cfg.refresh_token)) if not v]
        return {"enabled": self.cfg.enabled, "ready": self.ready, "missing": missing,
                "folder": bool(self.cfg.folder_id), "max_mb": self.cfg.max_mb,
                "levels": LEVELS, "kinds": KIND_LABELS}

    def _need(self) -> None:
        if not self.cfg.ready:
            if not self.cfg.enabled:
                raise DriveError("Google Drive выключен: GDRIVE_ENABLED=0")
            raise DriveError("Google Drive не подключён: задайте GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET "
                             "и GDRIVE_REFRESH_TOKEN (см. docs/drive.md)")

    # ---------- запросы ----------
    async def _access_token(self) -> str:
        self._need()
        async with self._lock:
            if self._token and self._expires > time.time() + 30:
                return self._token
            data = {"client_id": self.cfg.client_id, "client_secret": self.cfg.client_secret,
                    "refresh_token": self.cfg.refresh_token, "grant_type": "refresh_token"}
            status, body, _ = await self._request("POST", TOKEN_URL, data=data)
            if status != 200:
                raise self._error(status, body, "токен не принят")
            try:
                payload = json.loads(body or b"{}")
            except ValueError:
                raise DriveError("Google вернул не JSON при обмене токена") from None
            token = str(payload.get("access_token") or "")
            if not token:
                raise DriveError("Google не выдал access_token — проверьте refresh-токен и права drive.readonly")
            self._token = token
            self._expires = time.time() + max(60, int(payload.get("expires_in") or 3600))
            return token

    async def _request(self, method: str, url: str, params: dict | None = None, data: dict | None = None,
                       *, auth: bool = False, accept: str = "application/json") -> tuple[int, bytes, str]:
        headers = {"Accept": accept}
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if auth:
            headers["Authorization"] = f"Bearer {await self._access_token()}"
        if self._transport is not None:
            return await self._transport(method, url, params, data, headers)
        return await _aiohttp_transport(method, url, params, data, headers, self.timeout)

    async def _json(self, method: str, url: str, params: dict | None = None, data: dict | None = None) -> dict:
        status, body, _ = await self._request(method, url, params, data, auth=True)
        if status != 200:
            raise self._error(status, body, "Диск не ответил")
        try:
            return json.loads(body or b"{}")
        except ValueError:
            raise DriveError("Диск вернул не JSON") from None

    @staticmethod
    def _error(status: int, body: bytes, what: str) -> DriveError:
        detail = ""
        try:
            payload = json.loads(body or b"{}")
            detail = str(((payload.get("error") or {}).get("message") if isinstance(payload, dict) else "") or "")
        except ValueError:
            detail = ""
        if status == 401:
            return DriveError("Google не принял токен: обновите refresh-токен (docs/drive.md)")
        if status == 403:
            if "insufficient" in detail.lower() or "scope" in detail.lower():
                return DriveError("у токена нет права drive.readonly — выпустите токен с этим правом")
            return DriveError("Google ограничил доступ (403): " + (detail or "попробуйте позже"))
        if status == 404:
            return DriveError("файл не найден или у аккаунта нет к нему доступа")
        return DriveError(f"{what} ({status})" + (f": {detail}" if detail else ""))

    # ---------- файлы ----------
    @staticmethod
    def _item(f: dict) -> dict:
        """Белый список полей: всё, чего здесь нет, не уходит даже в память процесса."""
        mime = str(f.get("mimeType") or "")
        size = f.get("size")
        num = int(size) if str(size or "").isdigit() else None
        return {"id": str(f.get("id") or ""), "name": str(f.get("name") or "Без имени"), "mime": mime,
                "kind": kind_of(mime), "size": num, "size_label": fmt_size(num),
                "modified": str(f.get("modifiedTime") or "")[:19]}

    @staticmethod
    def _query(text: str = "") -> str:
        parts = ["trashed = false", f"mimeType != '{FOLDER_MIME}'"]      # папки не выдаём
        word = re.sub(r"['\\]+", " ", (text or "").strip())[:80]
        if word:
            parts.append(f"name contains '{word}'")
        return " and ".join(parts)

    async def list(self, query: str = "", folder: str = "", limit: int = MAX_FILES) -> list[dict]:
        """Файлы (без папок), только безопасные поля. `folder` — папка вместо GDRIVE_FOLDER_ID."""
        self._need()
        q = self._query(query)
        folder_id = (folder or self.cfg.folder_id).strip()
        if folder_id:
            if not ID_RE.match(folder_id):
                raise DriveError("идентификатор папки Диска выглядит неверно")
            q += f" and '{folder_id}' in parents"
        data = await self._json("GET", FILES_URL, {
            "q": q, "pageSize": str(max(1, min(limit, MAX_FILES))), "orderBy": "modifiedTime desc",
            "fields": "files(id,name,mimeType,size,modifiedTime)", "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true"})
        return [self._item(f) for f in data.get("files", []) if isinstance(f, dict)]

    async def content(self, file_id: str, *, limit: int | None = None) -> dict:
        """Текст файла: документы Google — экспортом в markdown, текстовые — как есть."""
        self._need()
        file_id = (file_id or "").strip()
        if not ID_RE.match(file_id):
            raise DriveError("идентификатор файла выглядит неверно")
        cap = (limit or self.cfg.max_mb * 1024 * 1024)
        meta = await self._json("GET", f"{FILES_URL}/{file_id}",
                                {"fields": "id,name,mimeType,size", "supportsAllDrives": "true"})
        mime = str(meta.get("mimeType") or "")
        name = str(meta.get("name") or "Документ")
        size = int(meta["size"]) if str(meta.get("size") or "").isdigit() else None
        if size and size > cap:
            raise DriveError(f"файл больше {self.cfg.max_mb} МБ — откройте его на Диске")
        if mime == DOC_MIME:
            text = await self._download(f"{FILES_URL}/{file_id}/export", {"mimeType": "text/markdown"}, cap)
        elif kind_of(mime) == "text":
            text = await self._download(f"{FILES_URL}/{file_id}", {"alt": "media"}, cap)
        else:
            raise DriveError(f"так можно открыть документ Google или текстовый файл, а это {kind_of(mime)}")
        return {"id": file_id, "name": name, "mime": mime, "text": text}

    async def _download(self, url: str, params: dict, cap: int) -> str:
        merged = {**params, "supportsAllDrives": "true"}
        status, body, _ = await self._request("GET", url, merged, auth=True, accept="*/*")
        if status != 200:
            raise self._error(status, body, "не удалось прочитать файл")
        if len(body) > cap:
            raise DriveError(f"файл больше {self.cfg.max_mb} МБ — откройте его на Диске")
        return body.decode("utf-8", errors="replace")
