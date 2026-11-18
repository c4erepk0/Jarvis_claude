"""Операторы — люди, которые помогают владельцу вести дела через Atom.

Владелец (корень) приглашает оператора ссылкой, задаёт ему права, переписывается с ним и поручает задачи и встречи.
Оператор видит только своё: порученные задачи и встречи (или все — если разрешено), чат с владельцем, проекты (если
разрешено) — и отмечает выполненное.

Где что лежит:
  data/operators.json  — служебное: учётки, хэши приглашений, пароль владельца (scrypt), прочитанное. Не в хранилище:
                         хранилище синхронизируется (GitHub, телефон), а секретам там не место.
  Jarvis/Chat/<Имя>.md — переписка с оператором, обычная заметка Obsidian:
                         - 2026-11-19 10:02 · **Владелец**: текст
                           продолжение многострочного сообщения
  Задачи и встречи — обычные задачи Obsidian Tasks с тегом #оператор/<имя> (см. meetings.py).

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

from .vault import Vault

PERMS = {
    "tasks_all": "Видеть и отмечать все задачи (иначе — только порученные)",
    "meetings_all": "Видеть все встречи (иначе — только свои)",
    "add_tasks": "Создавать задачи",
    "projects": "Видеть проекты (без финансов и памяти)",
}
DEFAULT_PERMS = ["add_tasks"]
INVITE_DAYS = 7
OWNER = "Владелец"
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


class Operators:
    def __init__(self, data_dir: Path, vault: Vault, chat_dir: str = "Jarvis/Chat"):
        self.path = Path(data_dir) / "operators.json"
        self.vault = vault
        self.chat_dir = chat_dir.strip("/")
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
        if len(password) < 6:
            raise ValueError("пароль — не короче 6 символов")
        salt = secrets.token_bytes(16)
        self.data["owner"] = {"mode": "password", "salt": salt.hex(), "hash": _scrypt(password, salt),
                              "since": int(time.time())}
        self._save()

    def set_open(self) -> None:
        self.data["owner"] = {"mode": "open", "since": int(time.time())}
        self._save()

    def check_owner_password(self, password: str) -> bool:
        o = self.data["owner"]
        if o.get("mode") != "password" or not password:
            return False
        return hmac.compare_digest(_scrypt(password, bytes.fromhex(o["salt"])), o["hash"])

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

    @staticmethod
    def public(op: dict) -> dict:
        now = time.time()
        invite = op.get("invite") or {}
        if not op.get("active", True):
            status = "disabled"
        elif op.get("joined"):
            status = "active"
        else:
            status = "invited" if invite.get("expires", 0) > now else "expired"
        return {"id": op["id"], "name": op["name"], "slug": op["slug"], "tag": TAG_PREFIX + op["slug"],
                "perms": op.get("perms", []), "active": op.get("active", True), "status": status,
                "created": op.get("created"), "joined": op.get("joined"), "last_seen": op.get("last_seen"),
                "invite_expires": invite.get("expires"), "note": op.get("note", ""), "chat": op.get("chat", "")}

    def list(self) -> list[dict]:
        return [self.public(o) for o in self.data["operators"]]

    def _check_name(self, name: str, skip: str = "") -> str:
        name = re.sub(r"[\\/|#\[\]\n\r]+", " ", name).strip()
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

    def create(self, name: str, perms: list[str] | None = None, note: str = "") -> tuple[dict, str]:
        name = self._check_name(name)
        op = {"id": secrets.token_hex(6), "name": name, "slug": slug(name),
              "perms": self._perms(DEFAULT_PERMS if perms is None else perms), "active": True, "version": 1,
              "created": int(time.time()), "note": note.strip()[:300], "chat": f"{self.chat_dir}/{name}.md",
              "read": {"owner": 0, "operator": 0}}
        self.data["operators"].append(op)
        token = self._new_invite(op)
        self._save()
        return self.public(op), token

    def _new_invite(self, op: dict) -> str:
        token = secrets.token_urlsafe(24)
        op["invite"] = {"hash": _hash_token(token), "expires": int(time.time()) + INVITE_DAYS * 86400}
        return token

    def reinvite(self, op_id: str) -> str:
        """Новая ссылка-приглашение (старая перестаёт работать). Вошедший оператор продолжит работать."""
        op = self._find(op_id)
        token = self._new_invite(op)
        self._save()
        return token

    def invite_info(self, token: str) -> dict | None:
        op = self._by_token(token)
        return {"name": op["name"]} if op else None

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

    def accept(self, token: str) -> dict:
        """Принять приглашение: ссылка одноразовая, после входа — сессия оператора."""
        op = self._by_token(token)
        if not op:
            raise ValueError("приглашение недействительно или устарело — попросите новую ссылку")
        op["invite"] = {}
        op["joined"] = op.get("joined") or int(time.time())
        self._save()
        return op

    def update(self, op_id: str, *, name: str | None = None, perms: list[str] | None = None,
               active: bool | None = None, note: str | None = None) -> dict:
        op = self._find(op_id)
        if name is not None and name.strip() != op["name"]:
            new = self._check_name(name, skip=op_id)
            old_chat = op.get("chat", "")
            op["name"], op["slug"] = new, slug(new)
            new_chat = f"{self.chat_dir}/{new}.md"
            if old_chat and self.vault.exists(old_chat) and not self.vault.exists(new_chat):
                self.vault.move(old_chat, new_chat)
            op["chat"] = new_chat
        if perms is not None:
            op["perms"] = self._perms(perms)
        if note is not None:
            op["note"] = note.strip()[:300]
        if active is not None and bool(active) != op.get("active", True):
            op["active"] = bool(active)
            op["version"] = op.get("version", 1) + 1        # отключили — все его сессии перестают работать
        self._save()
        return self.public(op)

    def logout_all(self, op_id: str) -> None:
        op = self._find(op_id)
        op["version"] = op.get("version", 1) + 1
        self._save()

    def delete(self, op_id: str) -> None:
        op = self._find(op_id)
        self.data["operators"].remove(op)
        self._save()

    def session_ok(self, op_id: str, version: int) -> dict | None:
        op = self.get(op_id)
        if not op or not op.get("active", True) or op.get("version", 1) != version:
            return None
        return op

    def touch(self, op: dict) -> None:
        now = int(time.time())
        if now - (op.get("last_seen") or 0) > 60:          # не писать файл на каждый запрос
            op["last_seen"] = now
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
