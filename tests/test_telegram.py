"""Telegram, когда api.telegram.org недоступен или тормозит (например, закрыт у хостера):
оповещения не тормозят Jarvis, журнал не засоряется, после возврата связи всё работает."""
import asyncio
import logging
import time

from aiohttp import web
from aiohttp.test_utils import TestServer

from jarvis.telegram import Telegram, describe

from .conftest import make_jarvis

OWNER = 6814854650


class FakeTelegramAPI:
    """Поддельный Bot API: сначала «недоступен», потом отвечает; можно заставить тормозить отправку."""

    def __init__(self, fail_polls: int = 0, slow_send: float = 0):
        self.fail_polls, self.slow_send = fail_polls, slow_send
        self.polls, self.sent = 0, []
        self.delivered = False

    async def handler(self, request):
        method = request.match_info["method"]
        data = await request.json()
        if method == "getUpdates":
            self.polls += 1
            if self.polls <= self.fail_polls:
                return web.json_response({"ok": False, "description": "Conflict: terminated by other getUpdates"})
            if not self.delivered:
                self.delivered = True
                return web.json_response({"ok": True, "result": [{"update_id": 7, "message": {
                    "from": {"id": OWNER}, "chat": {"id": OWNER}, "text": "/start"}}]})
            await asyncio.sleep(0.05)
            return web.json_response({"ok": True, "result": []})
        if method == "sendMessage":
            if self.slow_send:
                await asyncio.sleep(self.slow_send)
            self.sent.append(data["text"])
            return web.json_response({"ok": True, "result": {}})
        return web.json_response({"ok": False, "description": "unknown"})

    def app(self):
        app = web.Application()
        app.router.add_post("/bot{token}/{method}", self.handler)
        return app


def test_describe_gives_a_reason_even_for_empty_errors():
    assert "таймаут" in describe(asyncio.TimeoutError())
    assert describe(ConnectionResetError()) == "ConnectionResetError"
    assert describe(RuntimeError("Telegram getMe: Unauthorized")) == "Telegram getMe: Unauthorized"


def test_notify_does_not_wait_for_slow_telegram(tmp_path, caplog):
    async def run():
        api = FakeTelegramAPI(slow_send=1.0)
        j = make_jarvis(tmp_path)
        async with TestServer(api.app()) as srv:
            tg = Telegram(j, "T", OWNER, api=str(srv.make_url("")))
            t0 = time.monotonic()
            await tg.notify("Сборка IPAStore упала", "error")
            assert time.monotonic() - t0 < 0.3          # вызвавший не ждёт Telegram
            await tg.close()                            # при выходе последние оповещения успевают уйти
            assert api.sent == ["🔴 Сборка IPAStore упала"]

            # недоступен совсем: оповещение не роняет Jarvis, причина — в журнале
            dead = Telegram(j, "T", OWNER, api="http://127.0.0.1:9", send_timeout=2)
            with caplog.at_level(logging.WARNING, logger="jarvis.telegram"):
                await dead.notify("тест")
                await dead.close()
            assert "оповещение в Telegram не отправлено" in caplog.text
        await j.close()
    asyncio.run(run())


def test_poll_backs_off_logs_once_and_recovers(tmp_path, caplog):
    async def run():
        api = FakeTelegramAPI(fail_polls=4)
        j = make_jarvis(tmp_path)
        async with TestServer(api.app()) as srv:
            tg = Telegram(j, "T", OWNER, api=str(srv.make_url("")), poll_timeout=1, retry=0.01, max_retry=0.04)
            with caplog.at_level(logging.INFO, logger="jarvis.telegram"):
                task = asyncio.create_task(tg.poll())
                for _ in range(200):
                    if api.sent:
                        break
                    await asyncio.sleep(0.02)
                task.cancel()
                await tg.close()
        await j.close()
        return api
    api = asyncio.run(run())
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "Conflict" in warnings[0].getMessage()   # 4 сбоя — одна запись
    assert "GitHub Actions" in warnings[0].getMessage()
    assert "снова доступен" in caplog.text
    assert api.sent and "J.A.R.V.I.S. на связи" in api.sent[0]               # после возврата отвечает
