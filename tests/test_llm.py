"""Мозг на GigaChat и YandexGPT (jarvis/llm.py): поддельные API в формате из официальной документации —
авторизация, вызов инструментов Jarvis, история, ошибки."""
import asyncio
import json
import uuid

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from jarvis.brain import TOOLS
from jarvis.config import Config
from jarvis.llm import GigaChat, clean_schema, functions

from .conftest import make_jarvis


def test_backend_choice(monkeypatch):
    assert Config().llm_backend == ""
    assert Config(gigachat_auth_key="k").llm_backend == "gigachat"
    assert Config(llm_provider="yandex", yandex_api_key="k").llm_backend == ""            # без каталога не работает
    assert Config(llm_provider="yandex", yandex_api_key="k", yandex_folder_id="b1g").llm_backend == "yandex"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert Config(gigachat_auth_key="k").llm_backend == "claude"                 # без JARVIS_LLM — Claude первым
    assert Config(llm_provider="gigachat", gigachat_auth_key="k").llm_backend == "gigachat"


def test_tool_schemas_are_converted():
    specs = {f["name"]: f for f in functions(TOOLS)}
    assert set(specs) == {t["name"] for t in TOOLS}
    task = specs["task_add"]["parameters"]
    assert task["required"] == ["text"] and "additionalProperties" not in task
    assert task["properties"]["priority"]["enum"][0] == "highest"
    assert clean_schema({"type": "object", "properties": {"x": {"type": "integer", "minimum": 1, "$ref": "#"}},
                         "additionalProperties": False}) == \
        {"type": "object", "properties": {"x": {"type": "integer", "minimum": 1}}}


def test_gigachat_certificate_loads():
    ctx = GigaChat(Config(gigachat_auth_key="k")).ssl_context()
    assert any("Russian Trusted Root CA" in str(c.get("subject")) for c in ctx.get_ca_certs())


class FakeGigaChat:
    def __init__(self):
        self.oauth_calls, self.chat_calls = 0, []
        self.expire_first = True

    async def oauth(self, request):
        assert request.headers["Authorization"] == "Basic S0VZOlNFQ1JFVA=="
        uuid.UUID(request.headers["RqUID"])                     # обязательный UUIDv4
        assert (await request.post())["scope"] == "GIGACHAT_API_PERS"
        self.oauth_calls += 1
        return web.json_response({"access_token": f"tok{self.oauth_calls}", "expires_at": 4102444800000})

    async def chat(self, request):
        body = await request.json()
        if self.expire_first:                                   # токен протух — Jarvis должен взять новый
            self.expire_first = False
            return web.json_response({"status": 401, "message": "Token has expired"}, status=401)
        assert request.headers["Authorization"] == f"Bearer tok{self.oauth_calls}"
        assert body["model"] == "GigaChat-2-Max" and body["function_call"] == "auto"
        assert body["messages"][0]["role"] == "system" and "J.A.R.V.I.S." in body["messages"][0]["content"]
        assert {f["name"] for f in body["functions"]} >= {"task_add", "money_add"}
        self.chat_calls.append(body)
        if body["messages"][-1]["role"] == "user":
            call = {"name": "task_add", "arguments": {"text": "проверить сервер", "due": "2026-11-10"}}
            message = {"role": "assistant", "content": "", "function_call": call,
                       "functions_state_id": "77d3fb14-457a-46ba-937e-8d856156d003"}
            return web.json_response({
                "choices": [{"index": 0, "finish_reason": "function_call", "message": message}],
                "usage": {"prompt_tokens": 150, "completion_tokens": 35, "total_tokens": 185}})
        message = {"role": "assistant", "content": "Записал на завтра, сэр."}
        return web.json_response({"choices": [{"index": 0, "finish_reason": "stop", "message": message}],
                                  "usage": {"prompt_tokens": 200, "completion_tokens": 10}})

    def app(self):
        app = web.Application()
        app.router.add_post("/api/v2/oauth", self.oauth)
        app.router.add_post("/v1/chat/completions", self.chat)
        return app


def test_gigachat_calls_jarvis_tools(tmp_path):
    async def run():
        api = FakeGigaChat()
        async with TestServer(api.app()) as srv:
            j = make_jarvis(tmp_path, llm_provider="gigachat", gigachat_auth_key="S0VZOlNFQ1JFVA==",
                            gigachat_url=str(srv.make_url("/v1")),
                            gigachat_oauth_url=str(srv.make_url("/api/v2/oauth")))
            assert j.brain.available and j.brain.title == "GigaChat"
            r = await j.brain.ask("запиши мне проверить сервер завтра")
            assert r.text == "Записал на завтра, сэр." and r.source == "gigachat"
            line = next(x for x in j.vault.read("Tasks/Inbox.md").splitlines() if "проверить сервер" in x)
            assert line.startswith("- [ ] проверить сервер") and "📅 2026-11-10" in line
            # история: вызов функции с functions_state_id, затем результат — роль function, JSON-объект строкой
            follow = api.chat_calls[-1]["messages"]
            call, result = follow[-2], follow[-1]
            assert call["functions_state_id"] == "77d3fb14-457a-46ba-937e-8d856156d003"
            assert result["role"] == "function" and result["name"] == "task_add"
            assert json.loads(result["content"])["text"] == "проверить сервер"
            assert api.oauth_calls == 2                          # второй — после «Token has expired»
            await j.brain.ask("и ещё одно")                      # токен живой — без нового запроса
            assert api.oauth_calls == 2
            assert j.brain.usage["input"] >= 350
            st = await j.state()
            assert st["brain"] == "GigaChat" and st["model"] == "GigaChat-2-Max"
            r = await j.brain.analyze_image(b"x", "image/jpeg")
            assert r.kind == "warn" and "Claude" in r.text
            await j.close()
    asyncio.run(run())


class FakeYandex:
    def __init__(self, status: int = 200):
        self.status, self.calls = status, []

    async def chat(self, request):
        if self.status != 200:
            return web.json_response({"error": {"message": "Unauthorized"}}, status=self.status)
        assert request.headers["Authorization"] == "Api-Key AQVN-test"
        assert request.headers["OpenAI-Project"] == "b1gfolder"
        body = await request.json()
        assert body["model"] == "gpt://b1gfolder/yandexgpt/rc" and body["tool_choice"] == "auto"
        assert body["tools"][0]["type"] == "function" and "parameters" in body["tools"][0]["function"]
        self.calls.append(body)
        if body["messages"][-1]["role"] == "user":
            args = json.dumps({"amount_rub": -450, "category": "Кафе", "note": "кофе"}, ensure_ascii=False)
            call = {"id": "000_8814e8ae", "type": "function", "function": {"name": "money_add", "arguments": args}}
            message = {"role": "assistant", "content": "", "tool_calls": [call]}
            return web.json_response({"choices": [{"index": 0, "finish_reason": "tool_calls", "message": message}]})
        return web.json_response({"choices": [{"index": 0, "finish_reason": "stop", "message": {
            "role": "assistant", "content": "Кофе записан: 450 ₽."}}]})

    def app(self):
        app = web.Application()
        app.router.add_post("/v1/chat/completions", self.chat)
        return app


def test_yandexgpt_calls_jarvis_tools(tmp_path):
    async def run():
        api = FakeYandex()
        async with TestServer(api.app()) as srv:
            j = make_jarvis(tmp_path, llm_provider="yandex", yandex_api_key="AQVN-test", yandex_folder_id="b1gfolder",
                            yandex_url=str(srv.make_url("/v1")))
            r = await j.brain.ask("кофе за 450")
            assert r.text == "Кофе записан: 450 ₽." and r.source == "yandex"
            month = j.today().strftime("%Y-%m")
            assert "-450" in j.vault.read(f"Finance/{month}.md")
            follow = api.calls[-1]["messages"]
            assert follow[-2]["tool_calls"][0]["id"] == "000_8814e8ae"
            assert follow[-1] == {"role": "tool", "tool_call_id": "000_8814e8ae", "content": follow[-1]["content"]}
            assert json.loads(follow[-1]["content"])
            await j.close()
    asyncio.run(run())


@pytest.mark.parametrize("status,kind,phrase", [(401, "error", "не принял ключ"), (500, "warn", "недоступен")])
def test_errors_do_not_break_history(tmp_path, status, kind, phrase):
    async def run():
        api = FakeYandex(status=status)
        async with TestServer(api.app()) as srv:
            j = make_jarvis(tmp_path, llm_provider="yandex", yandex_api_key="bad", yandex_folder_id="b1gfolder",
                            yandex_url=str(srv.make_url("/v1")))
            r = await j.brain.ask("привет, как дела")
            assert r.kind == kind and phrase in r.text and "YandexGPT" in r.text
            assert j.brain.messages == []                      # неудачный ход не остался в истории
            await j.close()
    asyncio.run(run())
