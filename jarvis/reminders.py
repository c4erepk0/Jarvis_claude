"""Напоминания «через 20 минут…» — хранятся в data/reminders.json, переживают перезапуск."""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path


class Reminders:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.items: list[dict] = []
        if self.path.exists():
            try:
                self.items = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self.items = []

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.items, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    def add(self, text: str, at: float) -> dict:
        item = {"id": uuid.uuid4().hex[:8], "text": text.strip(), "at": at}
        self.items.append(item)
        self.items.sort(key=lambda x: x["at"])
        self._save()
        return item

    def due(self, now: float | None = None) -> list[dict]:
        now = time.time() if now is None else now
        ready = [x for x in self.items if x["at"] <= now]
        if ready:
            self.items = [x for x in self.items if x["at"] > now]
            self._save()
        return ready

    def cancel(self, rid: str) -> bool:
        before = len(self.items)
        self.items = [x for x in self.items if x["id"] != rid]
        if len(self.items) != before:
            self._save()
            return True
        return False

    def upcoming(self) -> list[dict]:
        return list(self.items)
