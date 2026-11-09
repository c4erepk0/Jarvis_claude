"""Запуск: `python -m jarvis` (или `make run`)."""
from __future__ import annotations

import argparse
import asyncio
import logging
import secrets
import shutil
import signal
import sys
from dataclasses import replace
from pathlib import Path

from aiohttp import web

from .config import load_config
from .core import Jarvis
from .gitsync import GitSync, GitSyncError
from .telegram import Telegram
from .tunnel import ORDER, Tunnel
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


def ensure_access_code(cfg, env_file: Path = Path(".env")):
    """Для доступа из интернета (туннель) нужен код входа: если его нет — создаём и сохраняем в .env."""
    if cfg.access_code:
        return cfg, False
    code = secrets.token_urlsafe(8)
    try:
        with env_file.open("a", encoding="utf-8") as f:
            f.write(f"\n# создано автоматически для доступа через туннель\nJARVIS_ACCESS_CODE={code}\n")
    except OSError:
        pass
    return replace(cfg, access_code=code), True


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m jarvis", description="J.A.R.V.I.S.")
    p.add_argument("--tunnel", nargs="?", const="auto", choices=["auto", "cloudflare", "localhostrun", "pinggy"],
                   help="открыть по https-ссылке в Safari/с телефона через бесплатный туннель")
    return p.parse_args(argv)


async def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = parse_args(sys.argv[1:] if argv is None else argv)
    cfg = load_config()
    created_code = False
    if args.tunnel:
        cfg, created_code = ensure_access_code(cfg)
    if not cfg.is_local_only and not cfg.access_code:
        sys.exit("JARVIS_HOST открыт в сеть, но JARVIS_ACCESS_CODE не задан — дашборд с вашими финансами "
                 "был бы доступен всем. Задайте код входа в .env.")
    git = None
    if cfg.vault_git:
        git = GitSync(cfg.vault_path, cfg.vault_git, cfg.github_token, cfg.vault_git_interval)
        try:
            log.info("Память: %s", await git.prepare())
        except GitSyncError as e:
            sys.exit(f"Не удалось скачать хранилище из {cfg.vault_git}:\n{e}\n"
                     "Проверьте VAULT_GIT и GITHUB_TOKEN (право Contents: read/write на этот репозиторий).")
    if seed_vault(cfg.vault_path):
        log.info("Создано стартовое хранилище Obsidian: %s", cfg.vault_path.resolve())
    if git:
        try:
            await git.sync()
        except GitSyncError as e:
            log.warning("Первая синхронизация с GitHub не удалась: %s", e)
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
    background = []
    if git:
        jarvis.git = git
        background.append(asyncio.create_task(git.loop(), name="git"))
    if telegram:
        background.append(asyncio.create_task(telegram.poll(), name="telegram"))
    shown = "localhost" if cfg.is_local_only else cfg.host
    log.info("J.A.R.V.I.S. онлайн: http://%s:%s  · память: %s%s · мозг: %s · голос: %s", shown, cfg.port,
             jarvis.vault.root, f" ⇄ {cfg.vault_git}" if git else "",
             cfg.model if jarvis.brain.available else "только команды", cfg.tts_engine)
    tunnel = None
    if args.tunnel:
        order = ORDER if args.tunnel == "auto" else (args.tunnel,)
        tunnel = Tunnel(cfg.port, cfg.data_dir / "tools", order)
        url = await tunnel.start()
        if url:
            bar = "═" * 58
            print(f"\n{bar}\n  Откройте в Safari:  {url}\n  Код входа:         {cfg.access_code}"
                  f"{'  (сохранён в .env)' if created_code else ''}\n"
                  f"  Затем «Поделиться» → «На экран „Домой“».\n{bar}\n", flush=True)
        else:
            log.error("Туннель не поднялся ни одним способом — подробности в %s",
                      cfg.data_dir / "tools" / "tunnel.log")

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
        for task in background:
            task.cancel()
        if git:
            try:
                await git.sync()   # отправить последние изменения
            except Exception:  # noqa: BLE001
                pass
        if tunnel:
            await tunnel.stop()
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
