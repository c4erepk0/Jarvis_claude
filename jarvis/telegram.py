"""Jarvis в Telegram: оповещения и команды из любой точки мира (только от владельца).

Это отдельный бот (свой токен от @BotFather), не @IPA_Market_bot: у одного токена
может быть только один получатель обновлений.
"""
from __future__ import annotations

import asyncio
import html
import logging
from typing import TYPE_CHECKING

import aiohttp

if TYPE_CHECKING:
    from .core import Jarvis

log = logging.getLogger("jarvis.telegram")
COMMANDS = {"/brief": "доброе утро", "/tasks": "задачи на сегодня", "/money": "финансы",
            "/status": "статус проектов", "/diag": "протокол диагностика", "/help": "что ты умеешь"}


class Telegram:
    def __init__(self, jarvis: "Jarvis", token: str, owner_id: int, api: str = "https://api.telegram.org"):
        self.j = jarvis
        self.token = token
        self.owner = owner_id
        self.base = f"{api.rstrip('/')}/bot{token}"
        self._session: aiohttp.ClientSession | None = None
        self.offset = 0

    async def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=70), trust_env=True)
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def call(self, method: str, **params) -> dict:
        s = await self.session()
        async with s.post(f"{self.base}/{method}", json=params) as r:
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
        icon = {"error": "🔴", "warn": "🟠", "info": "🔵", "ok": "🟢"}.get(level, "🔵")
        await self.send(f"{icon} {text}")

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
        while True:
            try:
                updates = await self.call("getUpdates", offset=self.offset, timeout=50,
                                          allowed_updates=["message", "edited_message"])
                for upd in updates:
                    self.offset = upd["update_id"] + 1
                    try:
                        await self.handle_update(upd)
                    except Exception:  # noqa: BLE001
                        log.exception("ошибка обработки сообщения Telegram")
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — сеть пропала: ждём и пробуем снова
                log.warning("Telegram недоступен: %s", e)
                await asyncio.sleep(10)
