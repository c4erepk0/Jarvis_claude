"""Напоминания «через 20 минут…» — живут в Obsidian (`Jarvis/Reminders.md`), чтобы их видели все:
сервер, Jarvis на iPhone и GitHub Actions, который шлёт их в Telegram, когда приложение закрыто.

Формат строки: `- ⏰ 2026-11-09T14:30:00+03:00 — позвонить маме` (не похоже на задачу Obsidian Tasks).
"""
from __future__ import annotations

import re
import time
from datetime import datetime

from .vault import Vault

LINE = re.compile(r"^- ⏰ (\S+) — (.+)$")
HEADER = "# Напоминания\n\nJarvis напомнит голосом и в Telegram. Формат: `- ⏰ время — текст`.\n\n"


def _ts(iso: str) -> float | None:
    try:
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return None


class Reminders:
    def __init__(self, vault: Vault, path: str = "Jarvis/Reminders.md", tz=None):
        self.vault = vault
        self.path = path
        self.tz = tz

    def upcoming(self) -> list[dict]:
        if not self.vault.exists(self.path):
            return []
        out = []
        for line in self.vault.read(self.path).splitlines():
            m = LINE.match(line.strip())
            if m and (at := _ts(m.group(1))) is not None:
                out.append({"id": m.group(1), "at": at, "text": m.group(2).strip()})
        return sorted(out, key=lambda x: x["at"])

    def add(self, text: str, at: float) -> dict:
        iso = datetime.fromtimestamp(at, self.tz).astimezone(self.tz).isoformat(timespec="seconds")
        self.vault.append(self.path, f"- ⏰ {iso} — {text.strip()}", header=HEADER)
        return {"id": iso, "at": at, "text": text.strip()}

    def remove(self, ids: list[str]) -> None:
        if not ids or not self.vault.exists(self.path):
            return
        drop = set(ids)
        lines = self.vault.read(self.path).splitlines()
        keep = [ln for ln in lines if not ((m := LINE.match(ln.strip())) and m.group(1) in drop)]
        if len(keep) != len(lines):
            self.vault.write(self.path, "\n".join(keep) + "\n")

    def due(self, now: float | None = None) -> list[dict]:
        now = time.time() if now is None else now
        ready = [r for r in self.upcoming() if r["at"] <= now]
        self.remove([r["id"] for r in ready])
        return ready

    def cancel(self, rid: str) -> bool:
        if any(r["id"] == rid for r in self.upcoming()):
            self.remove([rid])
            return True
        return False
