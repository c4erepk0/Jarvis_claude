"""Записи управления взглядом — калибровки и нажатия — в хранилище (<папка Jarvis>/Gaze/…).

Их присылает дашборд (jarvis/webapp/static/gaze.js: Calibration.toSession; журнал нажатий — app.js), а читает
scripts/gaze_eval.mjs: по ним видно, насколько точен взгляд, и проверяются улучшения (tests/js/gaze-sessions.test.mjs).
Фото нет — только точки глаз и лица по кадрам. Тот же формат и проверка — в JS-ядре для iPhone (core/jarvis.js).
"""
from __future__ import annotations

import json
from datetime import datetime

from .vault import Vault

# вид записи → (подпапка, список строк записи)
KINDS = {"jarvis-gaze-session": ("sessions", "frames"), "jarvis-gaze-usage": ("usage", "clicks")}
MAX_BYTES = 6 * 2**20
MAX_ITEMS = 20_000


def save_record(vault: Vault, folder: str, data: object, now: datetime) -> str:
    """Проверить запись взгляда и сохранить её новым файлом; вернуть путь в хранилище."""
    if not isinstance(data, dict) or data.get("kind") not in KINDS:
        raise ValueError("это не запись взгляда")
    sub, items = KINDS[data["kind"]]
    version = data.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ValueError("нет версии записи")
    rows = data.get(items)
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"пустая запись: нет {items}")
    if len(rows) > MAX_ITEMS:
        raise ValueError("слишком длинная запись")
    screen = data.get("screen")
    if not isinstance(screen, dict) or not all(
            isinstance(screen.get(k), (int, float)) and not isinstance(screen.get(k), bool) and screen[k] > 0
            for k in ("w", "h")):
        raise ValueError("нет размера экрана")
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ValueError("слишком большая запись")
    base = f"{folder}/Gaze/{sub}/{now.strftime('%Y-%m-%d-%H%M%S')}"
    rel, n = f"{base}.json", 1
    while vault.exists(rel):
        n += 1
        rel = f"{base}-{n}.json"
    return vault.write(rel, text + "\n")
