"""Менеджер заметок и проектов: индекс хранилища, теги, обратные ссылки, шаблоны, переименование и
перемещение с правкой [[ссылок]], корзина, папки; проекты — создание, статус, страница; REST и голос.
То же для ядра iPhone — tests/js/files.test.mjs."""
import asyncio
from datetime import datetime

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.notes import fill_template, note_tags, rewrite_links
from jarvis.vault import VaultError, set_frontmatter_field
from jarvis.web import build_app

from .conftest import make_jarvis

CODE = "4815162342"
AUTH = {"Authorization": f"Bearer {CODE}"}


def test_rewrite_links_keeps_alias_and_heading():
    text = "[[IPAStore]] · [[Projects/IPAStore#Задачи|задачи]] · [[ipastore.md]] · [[IPAStore 2]] · [[Other/IPAStore]]"
    out = rewrite_links(text, "Projects/IPAStore.md", "Archive/IPA Store.md")
    assert out == ("[[IPA Store]] · [[Archive/IPA Store#Задачи|задачи]] · [[IPA Store]] · [[IPAStore 2]] · "
                   "[[Other/IPAStore]]")


def test_tags_template_and_frontmatter_field():
    text = ("---\ntags: [Работа, идея]\n---\n# X\nтекст #ipastore и #идея, не #123 и не `#код`\n"
            "```\n#код\n```\nhttp://a.ru/#frag\n")
    assert note_tags(text) == ["работа", "идея", "ipastore"]
    assert fill_template("# {{title}}\n{{date}} {{time}}", "Встреча", datetime(2026, 11, 16, 9, 5)) == \
        "# Встреча\n2026-11-16 09:05"
    src = "---\ntype: project\nstatus: active\ntags:\n  - a\nrepo: x/y\n---\n# P\n"
    assert set_frontmatter_field(src, "status", "paused") == src.replace("active", "paused")
    assert set_frontmatter_field(src, "tags", ["b"]) == \
        "---\ntype: project\nstatus: active\ntags: [b]\nrepo: x/y\n---\n# P\n"
    assert set_frontmatter_field(src, "url", "https://x.ru").endswith('url: "https://x.ru"\n---\n# P\n')
    assert set_frontmatter_field("# P\n", "status", "done") == "---\nstatus: done\n---\n# P\n"


def test_index_backlinks_move_trash(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        idx = j.act_files()
        paths = {f["path"] for f in idx["files"]}
        assert "Projects/IPAStore.md" in paths and "Templates/Встреча.md" in idx["templates"]
        assert {"Projects", "Templates"} <= set(idx["folders"])
        assert idx["tags"][0]["tag"] == "ipastore"
        assert all(not f["path"].startswith("Templates/") or f["type"] for f in idx["files"] if f["ext"] == ".md")

        # новая заметка по шаблону — подстановки заполнены; повтор — ошибка, ничего не затёрто
        r = await j.act_create_note("Встречи/Созвон", "Templates/Встреча.md")
        text = j.vault.read(r["path"])
        assert r["path"] == "Встречи/Созвон.md" and "# Созвон" in text and "{{" not in text
        with pytest.raises(VaultError, match="уже есть"):
            await j.act_create_note("Встречи/Созвон.md")
        await j.act_create_note("Ideas/X", content="см. [[Projects/IPAStore#Задачи|тут]] и [[IPAStore]] #идея\n")

        note = j.act_read_note("Projects/IPAStore.md")
        assert {"Home.md", "Ideas/X.md"} <= {b["path"] for b in note["backlinks"]} and "ipastore" in note["tags"]

        # переименование — ссылки поправлены везде, подписи и разделы на месте
        r = await j.act_move_note("Projects/IPAStore.md", "Projects/IPA Store")
        assert r["path"] == "Projects/IPA Store.md" and {"Home.md", "Ideas/X.md"} <= set(r["updated"])
        assert j.vault.read("Ideas/X.md") == "см. [[Projects/IPA Store#Задачи|тут]] и [[IPA Store]] #идея\n"
        assert "[[IPA Store]]" in j.vault.read("Home.md") and not j.vault.exists("Projects/IPAStore.md")
        assert j.projects.get("IPA Store").repo == "c4erepk0/IPAStore"

        # папка — целиком, с вложенными; внутрь себя нельзя; на занятое место нельзя
        await j.act_mkdir("Archive")
        with pytest.raises(VaultError, match="уже есть"):
            await j.act_mkdir("Archive")
        r = await j.act_move_note("Ideas", "Archive/Ideas")
        assert r["moved"] == 1 and j.vault.exists("Archive/Ideas/X.md") and not j.vault.is_dir("Ideas")
        with pytest.raises(VaultError, match="внутрь"):
            await j.act_move_note("Archive", "Archive/Sub")
        with pytest.raises(VaultError, match="уже есть"):
            await j.act_move_note("Home.md", "Встречи/Созвон.md")
        with pytest.raises(VaultError):
            await j.act_move_note("Home.md", "../Home.md")

        # корзина Obsidian: файл не стирается, одноимённый не затирается
        r = await j.act_trash_note("Archive/Ideas/X.md")
        assert r["trash"] == ".trash/Archive/Ideas/X.md" and (j.vault.root / r["trash"]).is_file()
        await j.act_create_note("Archive/Ideas/X.md", content="второй\n")
        assert (await j.act_trash_note("Archive/Ideas/X.md"))["trash"] == ".trash/Archive/Ideas/X 2.md"
        assert ".trash" not in str(j.act_files()["folders"])
        await j.close()
    asyncio.run(run())


def test_projects_create_status_overview(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        p = await j.act_project_create("Сайт студии", "Лендинг для студии", status="idea")
        assert p["note"] == "Projects/Сайт студии.md" and p["tag"] == "сайт-студии" and p["status"] == "idea"
        with pytest.raises(ValueError, match="уже есть"):
            await j.act_project_create("сайт студии")
        with pytest.raises(ValueError):
            await j.act_project_create("X", status="весело")

        t = await j.act_add_task("сверстать главную", project="Сайт студии", to_note=True)
        assert t["path"] == "Projects/Сайт студии.md"
        await j.act_add_task("купить домен", project="Сайт студии")            # во входящие, но с тегом проекта
        await j.act_create_note("Projects/Сайт студии/Бриф", content="# Бриф\n- [ ] согласовать цвета\n")
        await j.act_create_note("Ideas/Логотип", content="для [[Сайт студии]]\n")
        await j.act_complete_task(query="купить домен")

        # заметка в папке проекта — не отдельный проект
        assert [x.name for x in j.projects.list()] == ["IPAStore", "Jarvis", "Сайт студии"]
        ov = j.act_project_overview("сайт студии")
        assert ov["progress"] == {"done": 1, "total": 3, "percent": 33}
        assert {x["text"] for x in ov["tasks"]} == {"сверстать главную", "согласовать цвета"}
        assert [n["path"] for n in ov["notes"]] == ["Projects/Сайт студии/Бриф.md", "Ideas/Логотип.md"]
        assert ov["journal"][0].endswith("Проект создан") and ov["status_label"] == "идея"

        upd = await j.act_project_update("Сайт студии", "status", "active")
        assert upd["status"] == "active"
        text = j.vault.read("Projects/Сайт студии.md")
        assert "status: active" in text and "Статус: в работе" in text and text.count("type: project") == 1
        with pytest.raises(ValueError):
            await j.act_project_update("Сайт студии", "type", "x")
        await j.close()
    asyncio.run(run())


def test_voice_commands(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        r = await j.handle("создай проект «Кофейня»")
        assert r.kind == "ok" and j.vault.exists("Projects/Кофейня.md")
        assert (await j.handle("открой проект кофейня")).data == {"open_project": "Кофейня"}
        assert (await j.handle("открой хранилище")).data == {"open_files": True}
        r = await j.handle("удали заметку Кофейня")
        assert r.kind == "warn" and r.confirm and j.vault.exists("Projects/Кофейня.md")    # только после подтверждения
        r = await j.confirm(r.confirm["id"])
        assert r.kind == "ok" and not j.vault.exists("Projects/Кофейня.md")
        assert (j.vault.root / ".trash" / "Projects" / "Кофейня.md").is_file()
        await j.close()
    asyncio.run(run())


def test_files_and_projects_api(tmp_path):
    async def run():
        j = make_jarvis(tmp_path, access_code=CODE, secret="s" * 32)
        async with TestClient(TestServer(build_app(j))) as c:
            idx = await (await c.get("/api/files", headers=AUTH)).json()
            assert idx["templates"] and idx["folders"]
            r = await c.post("/api/files/new", json={"path": "Ideas/Идея кофейни", "template": "Templates/Идея.md"},
                             headers=AUTH)
            assert r.status == 200 and (await r.json())["path"] == "Ideas/Идея кофейни.md"
            r = await c.post("/api/files/new", json={"path": "Ideas/Идея кофейни"}, headers=AUTH)
            assert r.status == 400
            assert (await c.post("/api/files/folder", json={"path": "Archive"}, headers=AUTH)).status == 200
            r = await c.post("/api/files/move", json={"from": "Ideas/Идея кофейни.md", "to": "Archive/Кофейня"},
                             headers=AUTH)
            assert (await r.json())["path"] == "Archive/Кофейня.md"
            r = await c.post("/api/files/trash", json={"path": "Archive/Кофейня.md"}, headers=AUTH)
            assert (await r.json())["trash"].startswith(".trash/")
            assert (await c.post("/api/files/trash", json={"path": "нет.md"}, headers=AUTH)).status == 404
            assert (await c.post("/api/files/move", json={"from": ".obsidian/app.json", "to": "x.json"},
                                 headers=AUTH)).status == 400

            r = await c.post("/api/projects", json={"name": "Кофейня", "description": "Кофе навынос"}, headers=AUTH)
            assert r.status == 200 and (await r.json())["tag"] == "кофейня"
            r = await c.post("/api/projects/Кофейня/task", json={"text": "найти помещение"}, headers=AUTH)
            assert (await r.json())["path"] == "Projects/Кофейня.md"
            r = await c.post("/api/projects/Кофейня/update", json={"key": "status", "value": "paused"}, headers=AUTH)
            assert (await r.json())["status"] == "paused"
            ov = await (await c.get("/api/projects/Кофейня", headers=AUTH)).json()
            assert ov["progress"]["total"] == 1 and ov["tasks"][0]["text"] == "найти помещение"
            assert (await c.get("/api/projects/Нет", headers=AUTH)).status == 400
            assert (await c.get("/api/files")).status == 401
        await j.close()
    asyncio.run(run())
