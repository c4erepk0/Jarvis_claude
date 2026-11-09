"""Записи управления взглядом: калибровки и журнал нажатий — в хранилище (Jarvis/Gaze/…)."""
import asyncio
import json
from datetime import datetime

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.gaze import MAX_BYTES, save_record
from jarvis.vault import Vault
from jarvis.web import build_app

from .conftest import make_jarvis

NOW = datetime(2026, 11, 9, 9, 15, 30)


def session(**over):
    data = {"kind": "jarvis-gaze-session", "version": 1, "mode": "big", "screen": {"w": 390, "h": 844},
            "landmarks": [33, 133], "blend": ["eyeBlinkLeft"], "points": [{"x": 0.5, "y": 0.5, "check": False}],
            "frames": [{"t": 0, "p": 0, "lm": [0.1, 0.2, 0.3, 0.4], "b": [0.05]}], "result": {"errorPx": 48.5}}
    data.update(over)
    return data


def test_save_record(tmp_path):
    v = Vault(tmp_path)
    rel = save_record(v, "Jarvis", session(), NOW)
    assert rel == "Jarvis/Gaze/sessions/2026-11-09-091530.json"
    assert json.loads(v.read(rel))["result"]["errorPx"] == 48.5
    # в ту же секунду — второй файл, первый не затирается
    assert save_record(v, "Jarvis", session(), NOW) == "Jarvis/Gaze/sessions/2026-11-09-091530-2.json"
    usage = {"kind": "jarvis-gaze-usage", "version": 1, "screen": {"w": 390, "h": 844},
             "clicks": [{"t": 1, "label": {"x": 10, "y": 20}, "lm": [0.1], "b": [0]}]}
    assert save_record(v, "Jarvis", usage, NOW) == "Jarvis/Gaze/usage/2026-11-09-091530.json"
    # записи взгляда — не заметки: на графе голограммы их нет
    assert not any(n["id"].endswith(".json") for n in v.graph()["nodes"])


@pytest.mark.parametrize("data, error", [
    (["не словарь"], "не запись взгляда"),
    ({"kind": "что-то"}, "не запись взгляда"),
    (session(version=None), "версии"),
    (session(version=True), "версии"),
    (session(frames=[]), "пустая"),
    (session(screen={"w": 0, "h": 844}), "экрана"),
    (session(frames=[{"lm": "x" * 100}] * 20_001), "длинная"),
    (session(frames=[{"lm": "x" * (MAX_BYTES // 10)}] * 11), "большая"),
])
def test_save_record_rejects(tmp_path, data, error):
    with pytest.raises(ValueError, match=error):
        save_record(Vault(tmp_path), "Jarvis", data, NOW)


def test_gaze_api(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        async with TestClient(TestServer(build_app(j))) as c:
            r = await c.post("/api/gaze", json=session())
            path = (await r.json())["path"]
            assert r.status == 200 and path.startswith("Jarvis/Gaze/sessions/") and path.endswith(".json")
            assert json.loads(j.vault.read(path))["mode"] == "big"
            r = await c.post("/api/gaze", json={"kind": "jarvis-gaze-session"})
            assert r.status == 400 and "версии" in (await r.json())["error"]
            # большая калибровка (~0,5 МБ) проходит
            big = session(frames=[{"t": k, "p": 0, "lm": [0.1234] * 100, "b": [0.05] * 14} for k in range(900)])
            assert (await c.post("/api/gaze", json=big)).status == 200
    asyncio.run(run())
