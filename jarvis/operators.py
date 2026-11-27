"""Операторы — люди, которые помогают владельцу вести дела через Atom.

Владелец (корень) приглашает оператора ссылкой, задаёт права и общие проекты, переписывается с ним и поручает задачи
и встречи. У оператора — свой кабинет: порученное (отметить выполненное), личные задачи и заметки (своя папка в
хранилище), общие с ним проекты, приложения из каталога (apps: открывать / управлять), доверенные заметки владельца
(notes: заметка или папка, только чтение или с правкой), обмен файлами (files: папки на сервере Atom —
смотреть или ещё и загружать; см. fileshare.py), чат с владельцем и свои устройства (выйти на любом).

Вход оператора: по одноразовой ссылке-приглашению он задаёт пароль, дальше входит по имени и паролю с любого
устройства. Каждое устройство — отдельная сессия: видно, откуда и когда заходили, любую можно завершить.

Где что лежит:
  data/operators.json    — служебное: учётки, хэши паролей и приглашений (scrypt / sha256), сессии, прочитанное.
                           Не в хранилище: оно синхронизируется (GitHub, телефон), а секретам там не место.
  Команда/<Имя>/         — личная папка оператора: заметки и «Задачи.md» (его личные задачи). Владельцу видна в
                           хранилище, но личные задачи операторов не попадают в его списки задач.
  Jarvis/Chat/<Имя>.md   — переписка с оператором:
                           - 2026-11-19 10:02 · **Владелец**: текст
                             продолжение многострочного сообщения
  Поручения и встречи — задачи Obsidian Tasks с тегом #оператор/<имя> (см. meetings.py).

Только для сервера: в режиме «только iPhone» нет общего места, где жили бы учётки нескольких людей.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from .fileshare import LEVELS as FILE_LEVELS
from .vault import Vault

PERMS = {
    "tasks_all": "Видеть и отмечать все задачи владельца (иначе — только порученные)",
    "meetings_all": "Видеть все встречи (иначе — только свои)",
    "tasks_assign": "Ставить задачи в общие проекты",
}
# доступ к приложению из каталога: use — открывать; manage — ещё и править его заметку, а у приложения-проекта
# видеть и отмечать задачи проекта (как общий проект)
APP_LEVELS = {"use": "Открывать", "manage": "Управлять"}
BUILTIN_APPS = {"builtin:map": "Карта", "builtin:exchange": "Обмен файлами"}   # встроенные приложения
BUILTIN_INFO = {"builtin:map": {"icon": "🗺", "description": "Поиск мест, маршруты и навигация"},
                "builtin:exchange": {"icon": "⇅", "description": "Файлы для операторов: папки, загрузка, доступ"}}
MAX_SHARED = 100
INVITE_DAYS = 7
OWNER = "Владелец"
OWNER_KEY = ""                     # «кто» для сессий владельца
TEAM_DIR = "Команда"               # личные папки операторов
MAX_SESSIONS = 20
MSG = re.compile(r"^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · \*\*(.+?)\*\*: ?(.*)$")
TAG_PREFIX = "оператор/"


def slug(name: str) -> str:
    """«Иван Петров» → «иван-петров» — для тега #оператор/иван-петров."""
    s = re.sub(r"[^\w-]+", "-", name.strip().lower().replace("ё", "е"), flags=re.UNICODE).strip("-_")
    return s or "оператор"


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _scrypt(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32).hex()


def _password(password: str) -> dict:
    if len(password) < 6:
        raise ValueError("пароль — не короче 6 символов")
    salt = secrets.token_bytes(16)
    return {"salt": salt.hex(), "hash": _scrypt(password, salt)}


def _check(rec: dict | None, password: str) -> bool:
    if not rec or not rec.get("hash") or not password:
        return False
    return hmac.compare_digest(_scrypt(password, bytes.fromhex(rec["salt"])), rec["hash"])


def device_name(ua: str) -> str:
    """Короткое имя устройства по User-Agent: «Safari · iPhone», «Chrome · Windows»."""
    ua = ua or ""
    os_ = next((n for k, n in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"),
                               ("Mac OS X", "macOS"), ("Macintosh", "macOS"), ("CrOS", "ChromeOS"), ("Linux", "Linux"))
                if k in ua), "")
    browsers = (("YaBrowser", "Яндекс Браузер"), ("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                ("Chrome/", "Chrome"), ("Safari/", "Safari"))
    br = next((n for k, n in browsers if k in ua), "")
    if "python" in ua.lower() or "aiohttp" in ua.lower():
        br, os_ = "Скрипт", os_ or "API"
    return " · ".join(x for x in (br, os_) if x) or "Неизвестное устройство"


class Operators:
    def __init__(self, data_dir: Path, vault: Vault, chat_dir: str = "Jarvis/Chat", team_dir: str = TEAM_DIR):
        self.path = Path(data_dir) / "operators.json"
        self.vault = vault
        self.chat_dir = chat_dir.strip("/")
        self.team_dir = team_dir.strip("/")
        self.data = self._load()

    # ---------- хранение ----------
    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        data.setdefault("owner", {})
        data.setdefault("operators", [])
        return data

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    # ---------- владелец ----------
    @property
    def owner_mode(self) -> str:
        """'' — не настроено (первый запуск), password — вход по паролю, open — без пароля (один человек)."""
        return self.data["owner"].get("mode", "")

    def set_owner_password(self, password: str) -> None:
        rec = _password(password)
        o = self.data["owner"]
        o.update(mode="password", salt=rec["salt"], hash=rec["hash"], since=o.get("since") or int(time.time()))
        self._save()

    def set_open(self) -> None:
        self.data["owner"].update(mode="open", since=int(time.time()))
        self._save()

    def check_owner_password(self, password: str) -> bool:
        o = self.data["owner"]
        return o.get("mode") == "password" and _check(o, password)

    # ---------- сессии (устройства) ----------
    def _holder(self, who: str) -> dict:
        """who: OWNER_KEY ('') — владелец, иначе id оператора."""
        return self.data["owner"] if who == OWNER_KEY else self._find(who)

    def new_session(self, who: str, ua: str = "", ip: str = "") -> str:
        h = self._holder(who)
        sessions = h.setdefault("sessions", {})
        sid = secrets.token_hex(8)
        now = int(time.time())
        sessions[sid] = {"created": now, "last_seen": now, "device": device_name(ua), "ip": ip[:45]}
        if len(sessions) > MAX_SESSIONS:                   # самые старые забываются
            for old in sorted(sessions, key=lambda k: sessions[k]["last_seen"])[:len(sessions) - MAX_SESSIONS]:
                sessions.pop(old)
        if who != OWNER_KEY:
            h["last_seen"] = now
        self._save()
        return sid

    def session_valid(self, who: str, sid: str) -> bool:
        try:
            h = self._holder(who)
        except KeyError:
            return False
        if who == OWNER_KEY and sid in ("-", "0"):          # сессии владельца до учёта устройств
            return not h.get("legacy_off")
        if who != OWNER_KEY and not h.get("active", True):
            return False
        return sid in (h.get("sessions") or {})

    def touch_session(self, who: str, sid: str, ip: str = "") -> None:
        h = self._holder(who)
        s = (h.get("sessions") or {}).get(sid)
        now = int(time.time())
        changed = False
        if s and now - s["last_seen"] > 60:                 # не писать файл на каждый запрос
            s["last_seen"] = now
            if ip:
                s["ip"] = ip[:45]
            changed = True
        if who != OWNER_KEY and now - (h.get("last_seen") or 0) > 60:
            h["last_seen"] = now
            changed = True
        if changed:
            self._save()

    def sessions(self, who: str, current: str = "") -> list[dict]:
        h = self._holder(who)
        out = [{"sid": sid, **s, "current": sid == current} for sid, s in (h.get("sessions") or {}).items()]
        if who == OWNER_KEY and current in ("-", "0") and not h.get("legacy_off"):
            out.append({"sid": current, "created": None, "last_seen": None,
                        "device": "Это устройство (вход до учёта устройств)", "ip": "", "current": True})
        return sorted(out, key=lambda s: (not s["current"], -(s["last_seen"] or 0)))

    def revoke(self, who: str, sid: str) -> bool:
        h = self._holder(who)
        if (h.get("sessions") or {}).pop(sid, None) is None:
            return False
        self._save()
        return True

    def revoke_others(self, who: str, keep: str = "") -> int:
        """Выйти на всех устройствах, кроме keep ('' — на всех)."""
        h = self._holder(who)
        sessions = h.get("sessions") or {}
        gone = [k for k in sessions if k != keep]
        for k in gone:
            sessions.pop(k)
        if who == OWNER_KEY:
            h["legacy_off"] = True
        self._save()
        return len(gone)

    # ---------- операторы ----------
    def _find(self, op_id: str) -> dict:
        op = next((o for o in self.data["operators"] if o["id"] == op_id), None)
        if not op:
            raise KeyError("нет такого оператора")
        return op

    def get(self, op_id: str) -> dict | None:
        try:
            return self._find(op_id)
        except KeyError:
            return None

    def folder(self, op: dict) -> str:
        return f"{self.team_dir}/{op['name']}"

    def public(self, op: dict) -> dict:
        now = time.time()
        invite = op.get("invite") or {}
        if not op.get("active", True):
            status = "disabled"
        elif op.get("joined"):
            status = "active"
        else:
            status = "invited" if invite.get("expires", 0) > now else "expired"
        return {"id": op["id"], "name": op["name"], "slug": op["slug"], "tag": TAG_PREFIX + op["slug"],
                "perms": op.get("perms", []), "projects": op.get("projects", []), "apps": op.get("apps", []),
                "notes": op.get("notes", []), "files": op.get("files", []), "active": op.get("active", True),
                "status": status, "created": op.get("created"), "joined": op.get("joined"),
                "last_seen": op.get("last_seen"), "invite_expires": invite.get("expires"), "note": op.get("note", ""),
                "chat": op.get("chat", ""), "folder": self.folder(op), "has_password": bool(op.get("password")),
                "devices": len(op.get("sessions") or {})}

    def list(self) -> list[dict]:
        return [self.public(o) for o in self.data["operators"]]

    def _check_name(self, name: str, skip: str = "") -> str:
        name = re.sub(r"[\\/|#\[\]\n\r:*?\"<>]+", " ", name).strip()
        if not name:
            raise ValueError("укажите имя оператора")
        if len(name) > 60:
            raise ValueError("имя — до 60 символов")
        s = slug(name)
        if any(o["slug"] == s and o["id"] != skip for o in self.data["operators"]):
            raise ValueError(f"оператор «{name}» уже есть")
        return name

    @staticmethod
    def _perms(perms: Any) -> list[str]:
        return [p for p in (perms or []) if p in PERMS]

    @staticmethod
    def _projects(projects: Any) -> list[str]:
        return sorted({str(p).strip() for p in (projects or []) if str(p).strip()})

    @staticmethod
    def _apps(apps: Any) -> list[dict]:
        """[{id, level}] — id: путь заметки приложения из каталога или builtin:…; повтор — последний побеждает."""
        out: dict[str, str] = {}
        for a in apps or []:
            if isinstance(a, str):
                a = {"id": a}
            if not isinstance(a, dict):
                continue
            app_id = str(a.get("id") or "").strip().lstrip("/")
            level = str(a.get("level") or "use")
            if not app_id or ".." in app_id.split("/") or level not in APP_LEVELS:
                continue
            if app_id.startswith("builtin:") and app_id not in BUILTIN_APPS:
                continue
            out[app_id] = level
        return [{"id": k, "level": v} for k, v in sorted(out.items())][:MAX_SHARED]

    @staticmethod
    def _notes(notes: Any) -> list[dict]:
        """Доверенные заметки: [{path, edit}] — путь заметки или папки (тогда — все заметки в ней)."""
        out: dict[str, bool] = {}
        for n in notes or []:
            if isinstance(n, str):
                n = {"path": n}
            if not isinstance(n, dict):
                continue
            path = str(n.get("path") or "").replace("\\", "/").strip().strip("/")
            if not path or any(x in ("..", "") for x in path.split("/")) or path.startswith("."):
                continue
            out[path] = bool(n.get("edit"))
        return [{"path": k, "edit": v} for k, v in sorted(out.items())][:MAX_SHARED]

    @staticmethod
    def _files(items: Any) -> list[dict]:
        """Папки обмена файлами: [{path, name, level}]. Уровни — только view/upload.

        Путь нормализуется и проверяется здесь же: выдать папку с `..` или скрытым именем нельзя.
        Имя хранится рядом с путём, чтобы панель показывала, что выдано, даже если папку переименовали.
        """
        out: dict[str, dict] = {}
        for it in items or []:
            if isinstance(it, str):
                it = {"path": it}
            if not isinstance(it, dict):
                continue
            raw = str(it.get("path") or "").replace("\\", "/").strip().strip("/")
            parts = [p for p in raw.split("/") if p]
            if not parts or len(parts) > 6 or any(p in (".", "..") or p.startswith(".") for p in parts):
                continue
            path = "/".join(parts)
            level = str(it.get("level") or "view")
            if level not in FILE_LEVELS:
                continue
            name = re.sub(r"[\\/\n\r\t]+", " ", str(it.get("name") or "")).strip()[:200] or parts[-1]
            out[path] = {"path": path, "name": name, "level": level}
        return list(out.values())[:MAX_SHARED]

    def create(self, name: str, perms: list[str] | None = None, note: str = "",
               projects: list[str] | None = None, apps: list | None = None,
               notes: list | None = None, files: list | None = None) -> tuple[dict, str]:
        name = self._check_name(name)
        op = {"id": secrets.token_hex(6), "name": name, "slug": slug(name), "perms": self._perms(perms),
              "projects": self._projects(projects), "apps": self._apps(apps), "notes": self._notes(notes),
              "files": self._files(files), "active": True, "created": int(time.time()),
              "note": note.strip()[:300], "chat": f"{self.chat_dir}/{name}.md", "read": {"owner": 0, "operator": 0},
              "sessions": {}}
        self.data["operators"].append(op)
        token = self._new_invite(op)
        self._save()
        return self.public(op), token

    def _new_invite(self, op: dict) -> str:
        token = secrets.token_urlsafe(24)
        op["invite"] = {"hash": _hash_token(token), "expires": int(time.time()) + INVITE_DAYS * 86400}
        return token

    def reinvite(self, op_id: str) -> str:
        """Новая ссылка (старая перестаёт работать): войти на новом месте или задать новый пароль, если забыл."""
        op = self._find(op_id)
        token = self._new_invite(op)
        self._save()
        return token

    def invite_info(self, token: str) -> dict | None:
        op = self._by_token(token)
        return {"name": op["name"], "has_password": bool(op.get("password"))} if op else None

    def _by_token(self, token: str) -> dict | None:
        if not token:
            return None
        h = _hash_token(token)
        for op in self.data["operators"]:
            inv = op.get("invite") or {}
            if inv.get("hash") and hmac.compare_digest(inv["hash"], h) and inv.get("expires", 0) > time.time() \
                    and op.get("active", True):
                return op
        return None

    def accept(self, token: str, password: str = "") -> dict:
        """Принять приглашение: ссылка одноразовая; оператор задаёт пароль — для входа с других устройств."""
        op = self._by_token(token)
        if not op:
            raise ValueError("приглашение недействительно или устарело — попросите новую ссылку")
        if password or not op.get("password"):
            op["password"] = _password(password)          # без пароля ещё нет — значит, нужен
        op["invite"] = {}
        op["joined"] = op.get("joined") or int(time.time())
        self._save()
        return op

    def login(self, name: str, password: str) -> dict | None:
        """Вход оператора по имени и паролю (имя — без учёта регистра и «ё»)."""
        key = slug(name)
        op = next((o for o in self.data["operators"] if o["slug"] == key), None)
        if not op or not op.get("active", True) or not _check(op.get("password"), password):
            return None
        return op

    def set_password(self, op_id: str, old: str, new: str) -> None:
        op = self._find(op_id)
        if not _check(op.get("password"), old):
            raise ValueError("текущий пароль не подходит")
        op["password"] = _password(new)
        self._save()

    def update(self, op_id: str, *, name: str | None = None, perms: list[str] | None = None,
               active: bool | None = None, note: str | None = None, projects: list[str] | None = None,
               apps: list | None = None, notes: list | None = None, files: list | None = None) -> dict:
        op = self._find(op_id)
        if name is not None and name.strip() != op["name"]:
            new = self._check_name(name, skip=op_id)
            old_chat, old_dir = op.get("chat", ""), self.folder(op)
            op["name"], op["slug"] = new, slug(new)
            new_chat = f"{self.chat_dir}/{new}.md"
            if old_chat and self.vault.exists(old_chat) and not self.vault.exists(new_chat):
                self.vault.move(old_chat, new_chat)
            op["chat"] = new_chat
            if self.vault.resolve(old_dir).is_dir() and not self.vault.resolve(self.folder(op)).exists():
                self.vault.move(old_dir, self.folder(op))  # личная папка — за именем
        if perms is not None:
            op["perms"] = self._perms(perms)
        if projects is not None:
            op["projects"] = self._projects(projects)
        if apps is not None:
            op["apps"] = self._apps(apps)
        if notes is not None:
            op["notes"] = self._notes(notes)
        if files is not None:
            op["files"] = self._files(files)
        if note is not None:
            op["note"] = note.strip()[:300]
        if active is not None and bool(active) != op.get("active", True):
            op["active"] = bool(active)
            if not op["active"]:
                op["sessions"] = {}                         # отключили — выходит на всех устройствах сразу
        self._save()
        return self.public(op)

    def logout_all(self, op_id: str) -> None:
        self.revoke_others(op_id)

    def delete(self, op_id: str) -> None:
        op = self._find(op_id)
        self.data["operators"].remove(op)
        self._save()

    # ---------- чат ----------
    def messages(self, op_id: str, limit: int = 200) -> list[dict]:
        op = self._find(op_id)
        path = op.get("chat") or f"{self.chat_dir}/{op['name']}.md"
        if not self.vault.exists(path):
            return []
        out: list[dict] = []
        for line in self.vault.read(path).splitlines():
            m = MSG.match(line)
            if m:
                author = m.group(3)
                out.append({"date": m.group(1), "time": m.group(2), "author": author,
                            "from": "owner" if author == OWNER else "operator", "text": m.group(4)})
            elif out and line.startswith("  ") and line.strip():
                out[-1]["text"] += "\n" + line.strip()
        for i, msg in enumerate(out):
            msg["n"] = i + 1
        return out[-limit:]

    def post(self, op_id: str, sender: str, text: str, when: datetime) -> dict:
        """sender: owner | operator. Сообщение дописывается в заметку чата."""
        op = self._find(op_id)
        text = text.strip()
        if not text:
            raise ValueError("пустое сообщение")
        if len(text) > 4000:
            raise ValueError("сообщение длиннее 4000 символов")
        author = OWNER if sender == "owner" else op["name"]
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        entry = f"- {when.strftime('%Y-%m-%d %H:%M')} · **{author}**: {lines[0]}"
        entry += "".join(f"\n  {ln}" for ln in lines[1:])
        path = op.get("chat") or f"{self.chat_dir}/{op['name']}.md"
        head = (f"---\ntype: chat\noperator: {op['name']}\n---\n# Чат: {op['name']}\n\n"
                "Переписка владельца с оператором.\n\n")
        self.vault.append(path, entry, header=head)
        n = len(self.messages(op_id, limit=10**6))
        self.mark_read(op_id, sender, n)
        return {"date": when.strftime("%Y-%m-%d"), "time": when.strftime("%H:%M"), "author": author,
                "from": "owner" if sender == "owner" else "operator", "text": "\n".join(lines), "n": n}

    def mark_read(self, op_id: str, who: str, n: int) -> None:
        op = self._find(op_id)
        read = op.setdefault("read", {"owner": 0, "operator": 0})
        if read.get(who, 0) < n:
            read[who] = n
            self._save()

    def unread(self, op_id: str, who: str) -> int:
        """Сколько непрочитанных у who (owner — от оператора, operator — от владельца)."""
        op = self._find(op_id)
        seen = (op.get("read") or {}).get(who, 0)
        other = "operator" if who == "owner" else "owner"
        return sum(1 for m in self.messages(op_id, limit=10**6) if m["n"] > seen and m["from"] == other)
