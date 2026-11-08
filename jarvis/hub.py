"""Шина событий: всё, что происходит, мгновенно уходит на все открытые дашборды через WebSocket."""
from __future__ import annotations

import json
import logging
import time
from collections import deque
from typing import Any

from aiohttp import web

log = logging.getLogger("jarvis.hub")


class Hub:
    def __init__(self, history: int = 150):
        self.clients: set[web.WebSocketResponse] = set()
        self.events: deque[dict] = deque(maxlen=history)

    async def emit(self, kind: str, data: Any = None, *, log_it: bool = True) -> None:
        event = {"type": kind, "data": data, "ts": time.time()}
        if log_it:
            self.events.append(event)
        payload = json.dumps(event, ensure_ascii=False, default=str)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_str(payload)
            except (ConnectionResetError, RuntimeError):
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def recent(self, kinds: tuple[str, ...] = ("log", "alert", "workshop", "job")) -> list[dict]:
        return [e for e in self.events if e["type"] in kinds][-60:]
