"""Оповещения по расписанию (GitHub Actions) для режима «только iPhone»."""
import asyncio
import json
import time

from aiohttp.test_utils import TestServer

from jarvis.cron import STATE, tick
from jarvis.github import GitHub

from .conftest import make_jarvis
from .test_projects import fake_github


def test_reminders_briefing_and_ci_alerts(tmp_path):
    async def run():
        app, _ = fake_github()
        server = TestServer(app)
        await server.start_server()
        gh = GitHub("t", base_url=str(server.make_url("")).rstrip("/"))
        j = make_jarvis(tmp_path, github=gh, briefing_time="00:00")
        sent: list[str] = []

        async def send(text):
            sent.append(text)

        # напоминание, поставленное с iPhone (тот же формат строки)
        j.vault.append("Jarvis/Reminders.md", "- ⏰ 2020-01-01T09:00:00+03:00 — позвонить маме")
        j.reminders.add("ещё не пора", time.time() + 3600)

        await tick(j, send)
        assert "⏰ позвонить маме" in sent
        assert [r["text"] for r in j.reminders.upcoming()] == ["ещё не пора"]
        state = json.loads(j.vault.read(STATE))
        assert state["briefing"] == j.today().isoformat() and state["ci"]["IPAStore"]["conclusion"] == "failure"
        # первый проход только запоминает CI, брифинг уходит один раз в день
        assert not any("провалилась" in s for s in sent)
        assert sum(1 for s in sent if "Хорошего дня" in s) <= 1

        sent.clear()
        state["ci"]["IPAStore"] = {"id": 7, "conclusion": "success"}
        j.vault.write(STATE, json.dumps(state))
        j.github._cache.clear()
        await tick(j, send)
        assert any("провалилась" in s for s in sent)
        assert not any("Хорошего дня" in s for s in sent)

        sent.clear()
        j.github._cache.clear()
        await tick(j, send)
        assert sent == [], "повторно о той же сборке не пишем"
        await j.close()
        await server.close()
    asyncio.run(run())
