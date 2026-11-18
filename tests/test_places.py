"""Карта: сохранённые места (Jarvis/Places.md), API /api/places, голосовые команды карты."""
import asyncio
from datetime import date

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.intents import parse
from jarvis.places import Places
from jarvis.vault import Vault
from jarvis.web import build_app

from .conftest import make_jarvis


def test_places_table(tmp_path):
    p = Places(Vault(tmp_path / "v"))
    assert p.list() == []
    p.add("Дом", 40.7484, -73.9857, "350 5th Ave", "Дом")
    p.add("Работа", 40.758, -73.9855, "Times Square", "работа", "офис | 7 этаж")
    assert [x["name"] for x in p.list()] == ["Дом", "Работа"]
    assert p.list()[0] == {"name": "Дом", "lat": 40.7484, "lon": -73.9857, "address": "350 5th Ave",
                           "category": "дом", "note": ""}
    assert p.list()[1]["note"] == "офис / 7 этаж"            # «|» не ломает таблицу
    p.add("дом", 40.7, -74.0)                                  # то же название — обновить, не дублировать
    assert len(p.list()) == 2 and p.list()[0]["lat"] == 40.7
    text = p.vault.read("Jarvis/Places.md")
    assert "type: places" in text and "| дом | 40.700000 | -74.000000 |" in text
    assert p.remove("Работа") and not p.remove("Работа")
    with pytest.raises(ValueError):
        p.add("", 1, 1)
    with pytest.raises(ValueError):
        p.add("Луна", 95, 0)
    # строку, поправленную в Obsidian, читаем (запятая в числе, лишние пробелы); мусор пропускаем
    p.vault.write("Jarvis/Places.md", text + "|  Парк  | 40,78 | -73,96 | | |\n| Кривое | север | юг | | | |\n")
    assert [x["name"] for x in p.list()][-1] == "Парк"


@pytest.mark.parametrize("text,args", [
    ("открой карту", {}),
    ("маршрут до таймс-сквер", {"route": "таймс-сквер", "mode": "car"}),
    ("как дойти до центрального парка", {"route": "центрального парка", "mode": "foot"}),
    ("маршрут на велосипеде до бруклинского моста", {"route": "бруклинского моста", "mode": "bike"}),
    ("покажи на карте бруклинский мост", {"query": "бруклинский мост"}),
    ("где находится эмпайр стейт", {"query": "эмпайр стейт"}),
    ("где я", {"locate": True}),
    ("аптеки рядом", {"nearby": "pharmacy"}),
    ("ближайшее метро рядом", {"nearby": "metro"}),
    ("покажи нью-йорк", {"tour": True}),
])
def test_map_intents(text, args):
    it = parse(text, date(2026, 11, 18))
    assert it.name == "map" and it.args == args


def test_api_and_reply(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        async with TestClient(TestServer(build_app(j))) as c:
            r = await c.post("/api/places", json={"name": "Дом", "lat": 40.7484, "lon": -73.9857})
            assert (await r.json())["places"][0]["name"] == "Дом"
            assert (await (await c.get("/api/places")).json())["places"][0]["lon"] == -73.9857
            assert (await c.post("/api/places", json={"name": "x", "lat": "север", "lon": 1})).status == 400
            r = await c.post("/api/places", json={"action": "remove", "name": "Дом"})
            assert (await r.json())["places"] == []
            assert (await c.post("/api/places", json={"action": "remove", "name": "Дом"})).status == 400
        reply = await j.handle("маршрут пешком до таймс-сквер")
        assert "маршрут" in reply.text and reply.data["open_map"] == {"route": "таймс-сквер", "mode": "foot"}
        await j.close()
    asyncio.run(run())
