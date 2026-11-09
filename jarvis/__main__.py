"""Запуск: `python -m jarvis` (или `make run`)."""
from __future__ import annotations

import asyncio
import logging
import shutil
import signal
import sys
from pathlib import Path

from aiohttp import web

from .config import load_config
from .core import Jarvis
from .telegram import Telegram
from .watchers import Watchers
from .web import build_app

log = logging.getLogger("jarvis")
TEMPLATE = Path(__file__).resolve().parent.parent / "vault-template"


def seed_vault(vault: Path) -> bool:
    """Пустое хранилище → кладём стартовую структуру (существующие файлы не трогаем)."""
    vault.mkdir(parents=True, exist_ok=True)
    has_notes = any(p.suffix == ".md" for p in vault.rglob("*") if ".obsidian" not in p.parts)
    if has_notes or not TEMPLATE.is_dir():
        return False
    for src in TEMPLATE.rglob("*"):
        dst = vault / src.relative_to(TEMPLATE)
        if src.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
        elif not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    return True


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config()
    if not cfg.is_local_only and not cfg.access_code:
        sys.exit("JARVIS_HOST открыт в сеть, но JARVIS_ACCESS_CODE не задан — дашборд с вашими финансами "
                 "был бы доступен всем. Задайте код входа в .env.")
    if seed_vault(cfg.vault_path):
        log.info("Создано стартовое хранилище Obsidian: %s", cfg.vault_path.resolve())
    jarvis = Jarvis(cfg)
    watchers = Watchers(jarvis)
    telegram = None
    if cfg.telegram_enabled:
        telegram = Telegram(jarvis, cfg.telegram_token, cfg.telegram_owner_id)
        jarvis.notifiers.append(telegram.notify)

    app = build_app(jarvis)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, cfg.host, cfg.port)
    await site.start()
    watchers.start()
    poller = asyncio.create_task(telegram.poll()) if telegram else None
    shown = "localhost" if cfg.is_local_only else cfg.host
    log.info("J.A.R.V.I.S. онлайн: http://%s:%s  · память: %s · мозг: %s · голос: %s", shown, cfg.port,
             jarvis.vault.root, cfg.model if jarvis.brain.available else "только команды", cfg.tts_engine)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):  # Windows
            pass
    try:
        await stop.wait()
    finally:
        log.info("Отключаюсь, %s.", cfg.user_title)
        if poller:
            poller.cancel()
        await watchers.stop()
        if telegram:
            await telegram.close()
        await jarvis.close()
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
