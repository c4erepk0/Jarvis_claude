"""Выбор модели-мозга на главном экране: список подключённых (с ключом), смена без перезапуска, запоминание,
особенности моделей Claude (у Haiku нет фолбэка и поиска)."""
import asyncio

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.config import Config
from jarvis.models import options
from jarvis.web import build_app

from .conftest import make_jarvis
from .test_brain import FakeClient, resp, text
from .test_llm import FakeDeepSeek


def test_only_connected_models_are_listed(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    cfg = Config(deepseek_api_key="sk-ds", gigachat_auth_key="k", deepseek_model="deepseek-v4")
    opts = options(cfg, cfg.llm_ready(), ("deepseek", "deepseek-chat"))
    assert {o["backend"] for o in opts} == {"gigachat", "deepseek"}          # у Claude и Yandex нет ключа
    ds = [o for o in opts if o["backend"] == "deepseek"]
    assert ds[0]["model"] == "deepseek-v4" and ds[0]["note"] == "из настроек" and ds[0]["default"]
    assert [o["model"] for o in opts if o["active"]] == ["deepseek-chat"]
    assert options(Config(), Config().llm_ready(), None) == []


def test_switch_model_without_restart(tmp_path):
    async def run():
        api = FakeDeepSeek()
        claude = FakeClient([resp([text("Это Claude, сэр.")]), resp([text("Haiku на связи.")])])
        async with TestServer(api.app()) as srv:
            j = make_jarvis(tmp_path, llm=claude, local_first=False, deepseek_api_key="sk-ds-test",
                            deepseek_model="deepseek-reasoner", deepseek_url=str(srv.make_url("/v1")))
            st = await j.state()
            assert st["backend"] == "claude" and st["model_label"] == "Opus 5.5"
            info = j.brain.options()
            assert {o["backend"] for o in info["options"]} == {"claude", "deepseek"}
            assert [o["model"] for o in info["options"] if o["active"]] == ["claude-opus-5-5"]

            r = await j.brain.ask("привет")
            assert r.source == "claude" and len(j.brain.messages) == 2

            res = await j.brain.select("deepseek", "deepseek-reasoner")
            assert res["backend"] == "deepseek" and res["label"] == "Reasoner" and res["chosen"]
            assert j.brain.messages == [] and j.brain.notes                    # новый разговор, кратко помня прошлый
            r = await j.brain.ask("напомни продлить домен")
            assert r.source == "deepseek" and "продлить домен" in j.vault.read("Tasks/Inbox.md")
            assert (await j.state())["brain"] == "DeepSeek"

            await j.brain.select("claude", "claude-haiku-5-5")                 # у Haiku — без фолбэка и поиска
            r = await j.brain.ask("кто ты")
            call = claude.calls[-1]
            assert r.text == "Haiku на связи." and call["model"] == "claude-haiku-5-5"
            assert "fallbacks" not in call and "betas" not in call
            assert "web_search" not in [t["name"] for t in call["tools"]]

            with pytest.raises(ValueError):
                await j.brain.select("yandex", "yandexgpt/rc")                 # ключа нет — нельзя
            with pytest.raises(ValueError):
                await j.brain.select("deepseek", "gpt-5")                      # нет в списке
            await j.close()

            # выбор запомнился (data/settings.json) и действует после перезапуска
            j2 = make_jarvis(tmp_path, seed=False, llm=FakeClient([]), deepseek_api_key="sk-ds-test")
            assert (j2.brain.backend, j2.brain.model) == ("claude", "claude-haiku-5-5")
            await j2.close()
            # ключ убрали — выбор не ломает мозг: берётся тот, у кого ключ есть
            j3 = make_jarvis(tmp_path, seed=False, deepseek_api_key="sk-ds-test")
            assert (j3.brain.backend, j3.brain.model) == ("deepseek", "deepseek-chat")
            await j3.close()
    asyncio.run(run())


def test_brain_api(tmp_path):
    async def run():
        j = make_jarvis(tmp_path, llm=FakeClient([]), deepseek_api_key="sk-ds")
        async with TestClient(TestServer(build_app(j))) as c:
            r = await c.get("/api/brain")
            data = await r.json()
            assert r.status == 200 and data["backend"] == "claude"
            assert any(o["model"] == "deepseek-chat" for o in data["options"])
            r = await c.post("/api/brain", json={"backend": "deepseek", "model": "deepseek-chat"})
            assert r.status == 200 and (await r.json())["provider"] == "DeepSeek"
            assert (await (await c.get("/api/state")).json())["model_label"] == "Chat"
            r = await c.post("/api/brain", json={"backend": "gigachat", "model": "GigaChat-2-Max"})
            assert r.status == 400 and "не подключён" in (await r.json())["error"]
        await j.close()
    asyncio.run(run())
