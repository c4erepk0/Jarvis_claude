"""Jarvis по расписанию — для режима «только iPhone», когда сервера нет, а приложение закрыто.

GitHub Actions (`.github/workflows/jarvis-cron.yml`) раз в 15 минут скачивает хранилище Obsidian,
запускает `python -m jarvis.cron` и сохраняет изменения обратно. За один проход Jarvis:
- присылает в Telegram наступившие напоминания из `Jarvis/Reminders.md` и убирает их;
- раз в день, после BRIEFING_TIME, присылает утренний брифинг;
- сообщает о новой упавшей сборке CI в проектах и о том, что она снова зелёная.
Состояние (что уже отправлено) — в `.jarvis/state.json` внутри хранилища.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Awaitable, Callable

from .config import load_config
from .core import Jarvis
from .telegram import Telegram

log = logging.getLogger("jarvis.cron")
STATE = ".jarvis/state.json"
FAILED = ("failure", "timed_out", "startup_failure")
Send = Callable[[str], Awaitable[None]]


def _load_state(j: Jarvis) -> dict:
    try:
        return json.loads(j.vault.read(STATE))
    except (OSError, ValueError):
        return {}


async def tick(j: Jarvis, send: Send) -> list[str]:
    """Один проход. Возвращает отправленные сообщения."""
    state = _load_state(j)
    before = json.dumps(state, sort_keys=True)
    sent: list[str] = []

    async def say(text: str) -> None:
        await send(text)
        sent.append(text)

    for r in j.reminders.due():
        await say(f"⏰ {r['text']}")

    n = j.now()
    today, hhmm = n.date().isoformat(), n.strftime("%H:%M")
    bt = j.cfg.briefing_time
    if bt and state.get("briefing") != today and bt <= hhmm:
        h, m = map(int, bt.split(":"))
        if (n.hour * 60 + n.minute) - (h * 60 + m) <= 180:   # проснулись слишком поздно — вчерашний брифинг не шлём
            reply = await j.protocols.run("утро")
            await say(reply.text)
        state["briefing"] = today

    ci_state = state.setdefault("ci", {})
    for project in j.projects.list():
        if not project.repo:
            continue
        try:
            ci = (await j.github.repo_status(project.repo)).get("ci")
        except Exception as e:  # noqa: BLE001 — нет доступа/сети: попробуем в следующий раз
            log.info("GitHub %s: %s", project.repo, e)
            continue
        if not ci or ci.get("status") != "completed":
            continue
        prev = ci_state.get(project.name)
        if prev and prev.get("id") != ci.get("id"):
            if ci.get("conclusion") in FAILED:
                await say(f"🔴 {j.title.capitalize()}, сборка «{ci.get('name')}» в {project.name} провалилась: "
                          f"{ci.get('title') or ''} {ci.get('url') or ''}".strip())
            elif ci.get("conclusion") == "success" and prev.get("conclusion") in FAILED:
                await say(f"🟢 Сборка в {project.name} снова зелёная.")
        ci_state[project.name] = {"id": ci.get("id"), "conclusion": ci.get("conclusion")}

    if json.dumps(state, sort_keys=True) != before:
        j.vault.write(STATE, json.dumps(state, ensure_ascii=False, indent=1) + "\n")
    return sent


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    cfg = load_config()
    if not cfg.vault_path.is_dir():
        print(f"Хранилище не найдено: {cfg.vault_path}", file=sys.stderr)
        return 1
    j = Jarvis(cfg)
    tg = Telegram(j, cfg.telegram_token, cfg.telegram_owner_id) if cfg.telegram_enabled else None

    async def send(text: str) -> None:
        if tg:
            await tg.send(text)
        else:
            print(text)

    try:
        sent = await tick(j, send)
        log.info("отправлено сообщений: %d", len(sent))
    finally:
        if tg:
            await tg.close()
        await j.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
