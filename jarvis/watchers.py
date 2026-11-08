"""Фоновые «датчики» Jarvis: изменения в Obsidian, напоминания, CI и здоровье проектов, нагрузка, брифинг."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from . import diagnostics

if TYPE_CHECKING:
    from .core import Jarvis

log = logging.getLogger("jarvis.watchers")


class Watchers:
    def __init__(self, jarvis: "Jarvis"):
        self.j = jarvis
        self.tasks: list[asyncio.Task] = []
        self.ci_seen: dict[str, tuple[int | None, str | None]] = {}
        self.health_seen: dict[str, bool] = {}
        self.diag_strikes = 0
        self.last_briefing_day: str | None = None

    def start(self) -> None:
        j = self.j
        j.vault.subscribe(self.on_vault_change)
        self.tasks = [
            asyncio.create_task(j.vault.watch(j.cfg.watch_interval), name="vault"),
            asyncio.create_task(self._loop(5, self.reminders_tick), name="reminders"),
            asyncio.create_task(self._loop(5, self.diag_tick), name="diag"),
            asyncio.create_task(self._loop(j.cfg.ci_check_minutes * 60, self.projects_tick, delay=20), name="ci"),
            asyncio.create_task(self._loop(30, self.briefing_tick), name="briefing"),
        ]

    async def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    @staticmethod
    async def _loop(interval: float, fn, delay: float = 0) -> None:
        if delay:
            await asyncio.sleep(delay)
        while True:
            try:
                await fn()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("ошибка датчика %s", getattr(fn, "__name__", fn))
            await asyncio.sleep(interval)

    async def on_vault_change(self, paths: list[str]) -> None:
        """Заметку изменили на телефоне/компьютере → дашборды обновляются сразу."""
        j = self.j
        jarvis_writes = [p for p in paths if p.startswith(f"{j.cfg.jarvis_dir}/Conversations/")]
        await j.hub.emit("vault", {"paths": paths[:50], "count": len(paths)}, log_it=False)
        if len(jarvis_writes) != len(paths):
            await j.changed("all")

    async def reminders_tick(self) -> None:
        j = self.j
        if j.focus_until and time.time() >= j.focus_until:
            j.focus_until = None
            await j.hub.emit("focus", {"until": None}, log_it=False)
        for item in j.reminders.due():
            await j.alert(f"Напоминание: {item['text']}", "info")
            await j.changed("reminders")

    async def diag_tick(self) -> None:
        j = self.j
        if not j.hub.clients and self.diag_strikes == 0:
            return
        d = j.diagnostics()
        await j.hub.emit("diag", d, log_it=False)
        issues = diagnostics.problems(d, j.cfg.cpu_alert, j.cfg.ram_alert, j.cfg.disk_alert)
        if issues:
            self.diag_strikes += 1
            if self.diag_strikes == 12:  # ~минута подряд
                await j.alert(f"{j.title.capitalize()}, перегрузка систем: {', '.join(issues)}.", "warn")
        else:
            self.diag_strikes = 0

    async def projects_tick(self) -> None:
        j = self.j
        for project in j.projects.list():
            if project.repo:
                try:
                    st = await j.github.repo_status(project.repo)
                except Exception as e:  # noqa: BLE001
                    log.info("GitHub %s: %s", project.repo, e)
                    st = None
                ci = (st or {}).get("ci")
                if ci and ci.get("status") == "completed":
                    key = (ci.get("id"), ci.get("conclusion"))
                    prev = self.ci_seen.get(project.name)
                    if prev and prev[0] != key[0]:
                        if key[1] in ("failure", "timed_out", "startup_failure"):
                            await j.alert(f"{j.title.capitalize()}, сборка «{ci.get('name')}» в {project.name} "
                                          f"провалилась: {ci.get('title') or ''}".strip(), "error")
                        elif key[1] == "success" and prev[1] in ("failure", "timed_out", "startup_failure"):
                            await j.alert(f"Сборка в {project.name} снова зелёная.", "ok", speak=False)
                    self.ci_seen[project.name] = key
            health = await j.projects.check_health(project)
            if health is not None:
                prev_ok = self.health_seen.get(project.name)
                if prev_ok is True and not health["ok"]:
                    await j.alert(f"{j.title.capitalize()}, {project.name} не отвечает на проверку здоровья.", "error")
                elif prev_ok is False and health["ok"]:
                    await j.alert(f"{project.name} снова в сети.", "ok", speak=False)
                self.health_seen[project.name] = health["ok"]
        await j.changed("projects")

    async def briefing_tick(self) -> None:
        j = self.j
        if not j.cfg.briefing_time or not j.notifiers:
            return
        n = j.now()
        day = n.date().isoformat()
        if self.last_briefing_day == day or n.strftime("%H:%M") < j.cfg.briefing_time:
            return
        if n.strftime("%H:%M") > _plus_hours(j.cfg.briefing_time, 3):
            self.last_briefing_day = day  # проснулись поздно — не шлём вчерашний брифинг днём
            return
        self.last_briefing_day = day
        reply = await j.protocols.run("утро")
        for notify in j.notifiers:
            try:
                await notify(reply.text, "info")
            except Exception:  # noqa: BLE001
                log.exception("брифинг не отправлен")


def _plus_hours(hhmm: str, hours: int) -> str:
    try:
        h, m = map(int, hhmm.split(":"))
    except ValueError:
        return "23:59"
    return f"{min(23, h + hours):02d}:{m:02d}"
