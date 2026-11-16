"""Умный синтез проектов: заметки проектов, кандидаты в проекты (тег, папка, узел ссылок, type: project),
подсветка, оформление кандидата проектом — голосом, через Claude и REST. То же для iPhone —
tests/js/synthesis.test.mjs (одинаковые входные данные — одинаковый ответ)."""
import asyncio
import json
from datetime import date
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from jarvis import intents
from jarvis.synthesis import synthesize, tag_title
from jarvis.web import build_app

from .conftest import make_jarvis

FIXTURE = Path(__file__).parent / "js" / "fixtures" / "synthesis.json"   # ответ, который должен дать и JS
CODE = "4815162342"
AUTH = {"Authorization": f"Bearer {CODE}"}


def f(path, tags=(), links=(), type_=""):
    title = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    folder = path.rsplit("/", 1)[0] if "/" in path else ""
    return {"path": path, "title": title, "folder": folder, "ext": ".md", "tags": list(tags),
            "links": list(links), "type": type_}


FILES = [
    f("Projects/IPAStore.md", ["ipastore"], type_="project"),
    f("Projects/IPAStore/Встреча.md"),
    f("Ideas/Оплата Stars.md", ["ipastore"]),
    f("Notes/Обзор рынка.md", links=["IPAStore"]),
    f("Ремонт/Кухня.md", ["ремонт"]), f("Ремонт/Ванная.md"), f("Ремонт/Смета.md", links=["Кухня"]),
    f("Ideas/Кофейня 1.md", ["кофейня"]), f("Ideas/Кофейня 2.md", ["кофейня", "идея"]),
    f("Inbox/Подкаст.md", type_="project"),
    f("Notes/Книга.md"), f("Notes/Глава 1.md", links=["Книга"]), f("Notes/Глава 2.md", links=["Книга"]),
    f("Notes/План.md", links=["Книга", "Подкаст"]),
    f("Journal/2026-11-09.md", ["ремонт"]),
    f("Templates/Встреча.md", ["встреча"]),
    f("Projects/Сайт.md", type_="project"),
    f("Home.md", links=["IPAStore", "Ремонт/Кухня", "Projects/Сайт"]),   # оглавление — ни к одному проекту
]
PROJECTS = [{"name": "IPAStore", "note": "Projects/IPAStore.md", "tag": "ipastore", "status": "active"},
            {"name": "Сайт", "note": "Projects/Сайт.md", "tag": "сайт", "status": "idea"}]
TASKS = [{"path": "Tasks/Inbox.md", "tags": ["кофейня"], "open": True},
         {"path": "Notes/Обзор рынка.md", "tags": ["ipastore"], "open": True}]


def test_synthesis_projects_candidates_highlight():
    syn = synthesize(FILES, PROJECTS, TASKS)
    assert syn == json.loads(FIXTURE.read_text(encoding="utf-8"))["expected"]
    ipa = syn["projects"][0]
    # заметка проекта, его папка, тег и ссылка [[IPAStore]] — всё относится к проекту
    assert ipa["notes"] == ["Projects/IPAStore.md", "Ideas/Оплата Stars.md", "Notes/Обзор рынка.md",
                            "Projects/IPAStore/Встреча.md"]
    assert ipa["open_tasks"] == 1
    by = {c["name"]: c for c in syn["candidates"]}
    assert set(by) == {"Ремонт", "Кофейня", "Подкаст", "Книга"}
    assert by["Ремонт"]["kinds"] == ["folder"] and len(by["Ремонт"]["notes"]) == 3      # журнал — служебная папка
    assert by["Кофейня"]["kinds"] == ["tag"] and by["Кофейня"]["open_tasks"] == 1
    assert by["Подкаст"]["kinds"] == ["note"] and by["Подкаст"]["notes"] == ["Inbox/Подкаст.md", "Notes/План.md"]
    assert by["Книга"]["kinds"] == ["hub"] and "Notes/Глава 1.md" in by["Книга"]["notes"]
    assert syn["candidates"][0]["name"] == "Подкаст"                                    # type: project — самый весомый
    hl = syn["highlight"]
    assert hl["Ideas/Оплата Stars.md"] == {"kind": "project", "project": "IPAStore"}
    assert hl["Ремонт/Смета.md"] == {"kind": "candidate", "project": "Ремонт"}
    assert "Templates/Встреча.md" not in hl and "Journal/2026-11-09.md" not in hl
    # Home.md ссылается на два проекта — это оглавление: ни в один проект не входит и не подсвечивается
    assert all("Home.md" not in p["notes"] for p in syn["projects"]) and "Home.md" not in hl
    # уже оформленный проект — не кандидат
    again = synthesize(FILES, PROJECTS + [{"name": "Ремонт", "note": "Projects/Ремонт.md", "tag": "ремонт"}], TASKS)
    assert "Ремонт" not in {c["name"] for c in again["candidates"]}
    assert tag_title("сайт-студии") == "Сайт студии"


def test_synthesis_voice_brain_rest(tmp_path):
    assert intents.parse("Атом, синтез проектов", date(2026, 11, 9)).name == "synthesis"
    assert intents.parse("какие проекты есть в хранилище", date(2026, 11, 9)).name == "synthesis"
    assert intents.parse("статус проектов", date(2026, 11, 9)).name == "project_status"

    async def run():
        j = make_jarvis(tmp_path, access_code=CODE)
        for name in ("Кухня", "Ванная", "Смета"):
            await j.act_create_note(f"Ремонт/{name}", content=f"# {name}\n- [ ] замер #ремонт\n")
        r = await j.handle("атом, синтез проектов")
        assert "Ремонт" in r.text and r.data["highlight"]["Ремонт/Кухня.md"]["kind"] == "candidate"
        # проект «Atom» из шаблона: его задача с #atom во входящих — заметка проекта
        assert "Tasks/Inbox.md" in next(p for p in r.data["projects"] if p["name"] == "Atom")["notes"]

        async with TestClient(TestServer(build_app(j))) as c:
            res = await c.get("/api/synthesis", headers=AUTH)
            body = await res.json()
            assert res.status == 200 and any(x["name"] == "Ремонт" for x in body["candidates"])
            res = await c.post("/api/synthesis", headers=AUTH, json={"name": "ремонт"})
            p = await res.json()
            assert res.status == 200 and p["note"] == "Projects/Ремонт.md" and p["status"] == "idea"
            text = j.vault.read("Projects/Ремонт.md")
            assert "tag: ремонт" in text and "[[Ремонт/Кухня|Кухня]]" in text and "Собран синтезом" in text
            # теперь это проект: кандидата нет, материалы — на странице проекта, задачи — по тегу
            body = await (await c.get("/api/synthesis", headers=AUTH)).json()
            assert all(x["name"] != "Ремонт" for x in body["candidates"])
            assert body["highlight"]["Ремонт/Смета.md"] == {"kind": "project", "project": "Ремонт"}
            ov = j.act_project_overview("Ремонт")
            assert {n["path"] for n in ov["notes"]} == {"Ремонт/Кухня.md", "Ремонт/Ванная.md", "Ремонт/Смета.md"}
            assert ov["progress"]["total"] == 3
            res = await c.post("/api/synthesis", headers=AUTH, json={"name": "нет такого"})
            assert res.status == 400
        await j.close()
    asyncio.run(run())
