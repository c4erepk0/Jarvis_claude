"""Заметки в голограмме: чтение с версией, правка без затирания чужих изменений, создание,
«открой заметку …», инструменты мозга для заметок, речь без markdown, повтор запроса к модели."""
import asyncio
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from jarvis import llm
from jarvis.brain import TOOLS
from jarvis.llm import functions
from jarvis.ru import speech_text
from jarvis.vault import VaultConflict, content_version
from jarvis.web import build_app

from .conftest import make_jarvis

CODE = "4815162342"


def spy_events(j) -> list[tuple[str, dict]]:
    """События шины, в том числе те, что не попадают в историю (open_note)."""
    seen, original = [], j.hub.emit

    async def emit(kind, data=None, **kw):
        seen.append((kind, data))
        await original(kind, data, **kw)
    j.hub.emit = emit
    return seen


AUTH = {"Authorization": f"Bearer {CODE}"}


def test_content_version_matches_js():
    # те же значения проверяет tests/js/notes.test.mjs — Python и iPhone-ядро считают одинаково
    assert content_version("") == "0-811c9dc5"
    assert content_version("привет") == "12-8148137f"
    assert content_version("# Заметка\n- [ ] задача\n") == "36-402b75cb"


def test_save_detects_changes_made_in_obsidian(tmp_path):
    j = make_jarvis(tmp_path)
    v = j.vault
    base = content_version(v.read("Home.md"))
    v.save("Home.md", "# Дом\nновый текст\n", base)
    assert v.read("Home.md") == "# Дом\nновый текст\n"
    with pytest.raises(VaultConflict) as e:                       # правка со старой версией — отказ
        v.save("Home.md", "моя правка", base)
    assert e.value.current == "# Дом\nновый текст\n" and v.read("Home.md") == "# Дом\nновый текст\n"
    with pytest.raises(VaultConflict, match="уже есть"):
        v.save("Home.md", "x", None)
    assert v.find_note("ipastore") == "Projects/IPAStore.md"
    assert v.find_note("Projects/Jarvis") == "Projects/Jarvis.md"
    assert v.find_note("несуществующее-слово-xyz") is None


def test_notes_api(tmp_path):
    async def run():
        j = make_jarvis(tmp_path, access_code=CODE, secret="s" * 32)
        async with TestClient(TestServer(build_app(j))) as c:
            n = await (await c.get("/api/note?path=Projects/IPAStore.md", headers=AUTH)).json()
            assert n["title"] == "IPAStore" and n["editable"] and n["version"] == content_version(n["content"])

            text = n["content"] + "\n## Идеи\n- экспорт в CSV\n"
            r = await c.put("/api/note", json={"path": n["path"], "content": text, "base": n["version"]}, headers=AUTH)
            saved = await r.json()
            assert r.status == 200 and saved["version"] == content_version(text)
            assert "экспорт в CSV" in j.vault.read("Projects/IPAStore.md")

            # тем временем заметку поправили в Obsidian — старая версия не затирает
            j.vault.write("Projects/IPAStore.md", text + "- правка с телефона\n")
            r = await c.put("/api/note", json={"path": n["path"], "content": "затёр", "base": saved["version"]},
                            headers=AUTH)
            conflict = await r.json()
            assert r.status == 409 and conflict["conflict"] and "правка с телефона" in conflict["current"]["content"]
            assert "правка с телефона" in j.vault.read("Projects/IPAStore.md")

            r = await c.post("/api/note", json={"path": "Ideas/Голограмма", "content": "# Идея\n"}, headers=AUTH)
            assert r.status == 200 and (await r.json())["path"] == "Ideas/Голограмма.md"
            r = await c.post("/api/note", json={"path": "Ideas/Голограмма.md", "content": "x"}, headers=AUTH)
            assert r.status == 409
            for bad in ({"path": "../etc/passwd", "content": "x"}, {"path": "a.canvas", "content": "{}"}):
                assert (await c.post("/api/note", json=bad, headers=AUTH)).status == 400
            assert (await c.put("/api/note", json={"path": "Home.md", "content": "x"}, headers=AUTH)).status == 400
        await j.close()
    asyncio.run(run())


def test_open_note_command_shows_it_in_hologram(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        seen = spy_events(j)
        r = await j.handle("Джарвис, открой заметку IPAStore")
        assert r.kind == "ok" and r.data == {"open_note": "Projects/IPAStore.md"} and "голограмм" in r.text
        assert ("open_note", {"path": "Projects/IPAStore.md"}) in seen
        r = await j.handle("открой заметку квантовый-телепорт-xyz")
        assert r.kind == "error"
        await j.close()
    asyncio.run(run())


def test_speech_text_strips_markdown():
    assert speech_text("**Готово**, сэр. Задачи:\n- [ ] купить молоко\n- позвонить _маме_\n\n"
                       "См. [[Projects/IPAStore|IPAStore]] и [сайт](https://x.ru)") == \
        "Готово, сэр. Задачи: купить молоко. позвонить маме. См. IPAStore и сайт"
    assert speech_text("## План\n1. Шаг один\n2) Шаг два") == "План. Шаг один. Шаг два"
    assert speech_text("файл snake_case_name и 2*3=6") == "файл snake_case_name и 2*3=6"


def test_gigachat_gets_few_shot_examples():
    specs = {f["name"]: f for f in functions(TOOLS, examples=True)}
    assert specs["note_show"]["few_shot_examples"][0]["params"] == {"path": "IPAStore"}
    assert all("few_shot_examples" not in f for f in functions(TOOLS))     # YandexGPT — без них


class ScriptedModel:
    """Поддельный YandexGPT: отвечает по сценарию — сначала вызовы инструментов, потом текст."""

    def __init__(self, script, fail_first: int = 0):
        self.script, self.fail_first, self.requests = list(script), fail_first, []

    async def chat(self, request):
        if self.fail_first:
            self.fail_first -= 1
            return web.json_response({"error": {"message": "temporarily unavailable"}}, status=503)
        body = await request.json()
        self.requests.append(body)
        step = self.script.pop(0)
        if isinstance(step, str):
            msg = {"role": "assistant", "content": step}
            return web.json_response({"choices": [{"finish_reason": "stop", "message": msg}]})
        calls = [{"id": f"c{i}", "type": "function",
                  "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}
                 for i, (name, args) in enumerate(step)]
        msg = {"role": "assistant", "content": "", "tool_calls": calls}
        return web.json_response({"choices": [{"finish_reason": "tool_calls", "message": msg}]})

    def app(self):
        app = web.Application()
        app.router.add_post("/v1/chat/completions", self.chat)
        return app


def test_brain_edits_the_note_open_in_hologram(tmp_path, monkeypatch):
    monkeypatch.setattr(llm, "RETRY_DELAY", 0)

    async def run():
        model = ScriptedModel([
            [("note_read", {"path": "IPAStore"})],
            [("note_edit", {"path": "Projects/IPAStore.md", "find": "status: active", "replace": "status: paused"})],
            [("note_edit", {"path": "Projects/IPAStore.md", "find": "нет такого фрагмента", "replace": "x"})],
            [("notes_list", {"folder": "Projects"}), ("note_show", {"path": "Jarvis"}),
             ("note_create", {"path": "Ideas/План", "text": "# План\n"})],
            "**Готово**, сэр:\n- статус — пауза\n- план создан",
        ], fail_first=1)
        async with TestServer(model.app()) as srv:
            j = make_jarvis(tmp_path, llm_provider="yandex", yandex_api_key="k", yandex_folder_id="b1g",
                            yandex_url=str(srv.make_url("/v1")))
            seen = spy_events(j)
            r = await j.handle("поставь этот проект на паузу", note="Projects/IPAStore.md")
            assert r.text.startswith("**Готово**")
            assert r.as_dict()["speech"] == "Готово, сэр: статус — пауза. план создан"
            assert "status: paused" in j.vault.read("Projects/IPAStore.md")
            assert j.vault.read("Ideas/План.md") == "# План\n"
            first_user = model.requests[0]["messages"][1]["content"]
            assert "[В голограмме открыта заметка: Projects/IPAStore.md]" in first_user
            results = [m["content"] for m in model.requests[-1]["messages"] if m["role"] == "tool"]
            assert any("фрагмент не найден" in v for v in results)          # ошибка ушла модели, не уронила Jarvis
            assert any("Projects/Jarvis.md" in v for v in results)
            assert ("open_note", {"path": "Projects/Jarvis.md"}) in seen
            await j.close()
    asyncio.run(run())


def test_edit_note_needs_a_unique_fragment(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        j.vault.write("A.md", "раз\nдва\nраз\n")
        with pytest.raises(ValueError, match="2 раз"):
            await j.act_edit_note("A.md", "раз", "три")
        await j.act_edit_note("A.md", "два", "")
        assert j.vault.read("A.md") == "раз\n\nраз\n"
        await j.close()
    asyncio.run(run())
