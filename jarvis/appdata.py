"""Общие данные приложений из каталога — например, изделия и прайсы «Ценников» у владельца и операторов.

Приложение, открытое внутри Atom (app-viewer.js), говорит с ним через postMessage (static/app-bridge.js): при запуске
получает общие данные, при каждом сохранении отдаёт их Atom, а Atom рассылает остальным открытым копиям (событие
WebSocket «appdata») — изменения владельца сразу появляются у операторов и наоборот.

Где лежит: data/appdata/<ключ>.json (ключ — sha1 пути заметки приложения), не в хранилище: в данных бывают картинки
на мегабайты, а хранилище — git-репозиторий, синхронизируется с телефоном, и каждая правка раздувала бы историю.
Пять прошлых версий — рядом (.1.json … .5.json): если кто-то случайно всё стёр, можно вернуть.

Кто может: владелец — любое приложение каталога; оператор — приложения, к которым ему дан доступ (apps).
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

MAX_BYTES = 12 * 2**20
BACKUPS = 5


class AppDataError(ValueError):
    pass


class AppData:
    def __init__(self, data_dir: Path):
        self.dir = Path(data_dir) / "appdata"

    @staticmethod
    def key(app: str) -> str:
        return hashlib.sha1(app.strip().encode()).hexdigest()[:16]

    def _path(self, app: str, n: int = 0) -> Path:
        return self.dir / (f"{self.key(app)}.json" if not n else f"{self.key(app)}.{n}.json")

    def get(self, app: str) -> dict:
        """{data, rev, updated, by} — пустые данные (rev 0), если ещё никто не сохранял."""
        try:
            rec = json.loads(self._path(app).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"app": app, "data": None, "rev": 0, "updated": None, "by": ""}
        return {"app": app, "data": rec.get("data"), "rev": rec.get("rev", 0), "updated": rec.get("updated"),
                "by": rec.get("by", "")}

    def set(self, app: str, data: Any, by: str) -> dict:
        """Сохранить новую версию (кто последний — тот и прав; приложение получает свежие данные сразу)."""
        if not isinstance(data, (dict, list)):
            raise AppDataError("данные приложения — объект JSON")
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        if len(raw.encode()) > MAX_BYTES:
            raise AppDataError(f"данных больше {MAX_BYTES // 2**20} МБ — уберите крупные картинки")
        cur = self.get(app)
        rec = {"app": app, "rev": cur["rev"] + 1, "updated": int(time.time()), "by": by}
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self._path(app)
        if path.exists():                                  # прошлые версии: .1 — самая свежая из старых
            for n in range(BACKUPS, 1, -1):
                older = self._path(app, n - 1)
                if older.exists():
                    os.replace(older, self._path(app, n))
            os.replace(path, self._path(app, 1))
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({**rec, "data": data}, ensure_ascii=False), encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        return rec

    def history(self, app: str) -> list[dict]:
        out = []
        for n in range(1, BACKUPS + 1):
            try:
                rec = json.loads(self._path(app, n).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            out.append({"n": n, "rev": rec.get("rev"), "updated": rec.get("updated"), "by": rec.get("by", "")})
        return out

    def restore(self, app: str, n: int, by: str) -> dict:
        try:
            rec = json.loads(self._path(app, int(n)).read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            raise AppDataError("такой версии нет") from None
        return self.set(app, rec.get("data"), by)
