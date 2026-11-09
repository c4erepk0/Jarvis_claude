"""Jarvis в Telegram: оповещения и команды из любой точки мира (только от владельца).

Это отдельный бот (свой токен от @BotFather), не @IPA_Market_bot: у одного токена
может быть только один получатель обновлений.
"""
from __future__ import annotations

import asyncio
import html
import logging
import time
from typing import TYPE_CHECKING

import aiohttp

if TYPE_CHECKING:
    from .core import Jarvis

log = logging.getLogger("jarvis.telegram")
SEND_TIMEOUT = 20      # отправка сообщения: дольше не ждём, чтобы не тормозить остальное
CONNECT_TIMEOUT = 15   # если до api.telegram.org не достучаться — понять это быстро
POLL_TIMEOUT = 50      # long polling: Telegram держит getUpdates открытым до 50 с
MAX_RETRY = 300        # при недоступности повторяем всё реже, но не реже раза в 5 минут
COMMANDS = {"/brief": "доброе утро", "/tasks": "задачи на сегодня", "/money": "финансы",
            "/status": "статус проектов", "/diag": "протокол диагностика", "/help": "что ты умеешь"}


def describe(e: BaseException) -> str:
    """Понятная причина сбоя: у таймаута и части сетевых ошибок текст пустой."""
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
        return "нет ответа (таймаут) — похоже, api.telegram.org недоступен с этого сервера"
    return str(e) or type(e).__name__


class Telegram:
    def __init__(self, jarvis: "Jarvis", token: str, owner_id: int, api: str = "https://api.telegram.org", *,
                 poll_timeout: int = POLL_TIMEOUT, retry: float = 10, max_retry: float = MAX_RETRY,
                 send_timeout: float = SEND_TIMEOUT):
        self.j = jarvis
        self.token = token
        self.owner = owner_id
        self.base = f"{api.rstrip('/')}/bot{token}"
        self._session: aiohttp.ClientSession | None = None
        self.offset = 0
        self.poll_timeout, self.retry, self.max_retry, self.send_timeout = poll_timeout, retry, max_retry, send_timeout
        self.down_since: float | None = None   # с какого момента Telegram не отвечает
        self._sending: set[asyncio.Task] = set()

    async def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(trust_env=True)
        return self._session

    async def close(self) -> None:
        if self._sending:   # дать уйти последним оповещениям
            await asyncio.wait(self._sending, timeout=5)
        if self._session and not self._session.closed:
            await self._session.close()

    async def call(self, method: str, *, wait: float | None = None, **params) -> dict:
        s = await self.session()
        total = wait or self.send_timeout
        timeout = aiohttp.ClientTimeout(total=total, connect=min(CONNECT_TIMEOUT, total))
        async with s.post(f"{self.base}/{method}", json=params, timeout=timeout) as r:
            data = await r.json(content_type=None)
        if not data.get("ok"):
            raise RuntimeError(f"Telegram {method}: {data.get('description')}")
        return data["result"]

    async def send(self, text: str, chat_id: int | None = None) -> None:
        for i in range(0, len(text), 3900):
            await self.call("sendMessage", chat_id=chat_id or self.owner, text=html.escape(text[i:i + 3900]),
                            parse_mode="HTML", disable_web_page_preview=True)

    async def send_voice(self, audio: bytes, chat_id: int | None = None) -> None:
        s = await self.session()
        form = aiohttp.FormData()
        form.add_field("chat_id", str(chat_id or self.owner))
        form.add_field("voice", audio, filename="jarvis.mp3", content_type="audio/mpeg")
        async with s.post(f"{self.base}/sendVoice", data=form) as r:
            await r.read()

    async def notify(self, text: str, level: str = "warn") -> None:
        """Оповещение уходит в фоне: если Telegram тормозит или недоступен, остальной Jarvis не ждёт."""
        icon = {"error": "🔴", "warn": "🟠", "info": "🔵", "ok": "🟢"}.get(level, "🔵")
        task = asyncio.create_task(self._deliver(f"{icon} {text}"))
        self._sending.add(task)
        task.add_done_callback(self._sending.discard)

    async def _deliver(self, text: str) -> None:
        try:
            await self.send(text)
        except Exception as e:  # noqa: BLE001
            log.warning("оповещение в Telegram не отправлено: %s", describe(e))

    async def handle_update(self, upd: dict) -> None:
        msg = upd.get("message") or upd.get("edited_message")
        if not msg:
            return
        user = (msg.get("from") or {}).get("id")
        chat = (msg.get("chat") or {}).get("id")
        if user != self.owner:
            log.warning("сообщение от чужого пользователя %s проигнорировано", user)
            return
        text = (msg.get("text") or msg.get("caption") or "").strip()
        if msg.get("voice") and not text:
            await self.send("Голосовые сообщения я пока не расшифровываю, сэр. Напишите текстом "
                            "или скажите голосом на дашборде.", chat)
            return
        if text.startswith("/start"):
            await self.send(f"J.A.R.V.I.S. на связи, {self.j.title}. Команды: " + ", ".join(COMMANDS), chat)
            return
        text = COMMANDS.get(text.split("@")[0], text)
        reply = await self.j.handle(text, source="telegram")
        out = reply.text
        if reply.confirm:
            out += "\n\nОтветьте «подтверждаю» или «отмена»."
        await self.send(out, chat)
        if self.j.cfg.telegram_voice_reply:
            audio = await self.j.voice.synthesize(reply.speech if reply.speech is not None else reply.text)
            if audio:
                await self.send_voice(audio[0], chat)

    async def poll(self) -> None:
        log.info("Telegram: жду сообщений от владельца %s", self.owner)
        delay, last_reason = self.retry, None
        while True:
            try:
                updates = await self.call("getUpdates", wait=self.poll_timeout + 20, offset=self.offset,
                                          timeout=self.poll_timeout, allowed_updates=["message", "edited_message"])
                if self.down_since is not None:
                    log.info("Telegram снова доступен (не было связи %d с)", time.monotonic() - self.down_since)
                    self.down_since, delay, last_reason = None, self.retry, None
                for upd in updates:
                    self.offset = upd["update_id"] + 1
                    try:
                        await self.handle_update(upd)
                    except Exception:  # noqa: BLE001
                        log.exception("ошибка обработки сообщения Telegram")
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — сеть пропала: ждём и пробуем снова, всё реже
                reason = describe(e)
                if self.down_since is None:
                    self.down_since = time.monotonic()
                if reason != last_reason:   # одна и та же причина — в журнал один раз, а не каждую минуту
                    log.warning("Telegram недоступен: %s. Повторяю всё реже (до раза в %d мин). Если так постоянно — "
                                "оповещения можно получать через GitHub Actions: docs/hosting.md, раздел 6.",
                                reason, self.max_retry // 60)
                    last_reason = reason
                await asyncio.sleep(delay)
                delay = min(self.max_retry, delay * 2)
