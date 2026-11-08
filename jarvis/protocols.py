"""Протоколы — макросы в духе Железного человека. Встроенные + свои из `Jarvis/Protocols.md`."""
from __future__ import annotations

import re
import time
from datetime import timedelta
from typing import TYPE_CHECKING

from . import diagnostics, ru

if TYPE_CHECKING:
    from .core import Jarvis, Reply

BUILTIN = {
    "утро": "Утренний брифинг: погода, задачи, финансы, проекты, курс",
    "фокус": "25 минут фокуса без отвлечений, потом напоминание о перерыве",
    "итоги": "Итоги дня: что сделано и потрачено — в ежедневную заметку",
    "неделя": "Обзор недели — отдельной заметкой в журнале",
    "диагностика": "Проверка систем: сервер, проекты, синхронизация, мозг",
    "чистый лист": "Убрать старые выполненные задачи в архив",
    "вечеринка": "Все проекты: статус и выкатка (с подтверждением)",
    "тишина": "Выключить голос (включить — «протокол голос»)",
    "голос": "Включить голос",
}
ALIASES = {"итоги дня": "итоги", "утренний брифинг": "утро", "брифинг": "утро", "домашняя вечеринка": "вечеринка",
           "режим фокуса": "фокус", "обзор недели": "неделя", "итоги недели": "неделя"}
FOCUS_MINUTES = 25


class Protocols:
    def __init__(self, jarvis: "Jarvis"):
        self.j = jarvis

    @property
    def path(self) -> str:
        return f"{self.j.cfg.jarvis_dir}/Protocols.md"

    def custom(self) -> dict[str, list[str]]:
        """Свои протоколы: `## Протокол «Название»` и список шагов `- команда`."""
        if not self.j.vault.exists(self.path):
            return {}
        out: dict[str, list[str]] = {}
        current = None
        for line in self.j.vault.read(self.path).splitlines():
            m = re.match(r"^##\s+(?:Протокол\s+)?[«\"']?(.+?)[»\"']?\s*$", line.strip(), re.I)
            if m:
                current = m.group(1).strip()
                out[current] = []
                continue
            m = re.match(r"^\s*[-*]\s+(.+)$", line)
            if m and current:
                out[current].append(m.group(1).strip())
        return {k: v for k, v in out.items() if v}

    def list(self) -> list[dict]:
        items = [{"name": k, "title": k.capitalize(), "description": v, "builtin": True}
                 for k, v in BUILTIN.items() if k != "голос"]
        for name, steps in self.custom().items():
            items.append({"name": name, "title": name, "description": " → ".join(steps), "builtin": False})
        return items

    async def run(self, name: str, depth: int = 0) -> "Reply":
        from .core import Reply
        key = name.lower().strip().strip("«»\"'")
        key = ALIASES.get(key, key)
        custom = {k.lower(): (k, v) for k, v in self.custom().items()}
        if key in custom and key not in BUILTIN:
            return await self._run_custom(*custom[key], depth=depth)
        handler = {
            "утро": self.morning, "фокус": self.focus, "итоги": self.evening, "неделя": self.week,
            "диагностика": self.diagnostics, "чистый лист": self.clean_slate, "вечеринка": self.party,
            "тишина": self.silence, "голос": self.unmute,
        }.get(key)
        if not handler:
            match = next((k for k in list(BUILTIN) + list(custom) if key and (key in k or k in key)), None)
            if match:
                return await self.run(match, depth)
            return Reply(f"Протокол «{name}» не найден, {self.j.title}. Свои протоколы можно описать в {self.path}.",
                         kind="warn")
        await self.j.hub.emit("protocol", {"name": key}, log_it=False)
        reply = await handler()
        reply.source = "protocol"
        await self.j.log(f"Протокол «{key}»", journal=key not in ("тишина", "голос"))
        return reply

    async def _run_custom(self, title: str, steps: list[str], depth: int) -> "Reply":
        from .core import Reply
        if depth >= 2:
            return Reply("Протоколы слишком глубоко вложены друг в друга — остановился.", kind="warn")
        await self.j.hub.emit("protocol", {"name": title}, log_it=False)
        texts = []
        for step in steps:
            r = await self.j.handle(step, source="protocol", depth=depth + 1)
            texts.append(r.text)
        await self.j.log(f"Протокол «{title}»: {len(steps)} шагов")
        return Reply(f"Протокол «{title}» выполнен. " + " ".join(texts), source="protocol")

    # ---------- встроенные ----------
    async def morning(self) -> "Reply":
        from .core import Reply, project_line
        j, n = self.j, self.j.now()
        ref = n.date()
        parts = [f"{ru.greeting(n.hour)}, {j.title}. Сейчас {n:%H:%M}, {ru.WEEKDAYS[n.weekday()]}, "
                 f"{n.day} {ru.MONTHS_GEN[n.month - 1]}."]
        weather = await j.briefing.weather()
        parts.append(j.briefing.weather_phrase(weather))
        today = j.tasks.view(ref, "today")
        overdue = j.tasks.view(ref, "overdue")
        if today:
            names = "; ".join(t.text for t in today[:5])
            parts.append(f"На сегодня {len(today)} {ru.plural(len(today), 'задача', 'задачи', 'задач')}: {names}.")
        else:
            parts.append("На сегодня задач со сроком нет.")
        if overdue:
            parts.append(f"Просрочено: {len(overdue)}.")
        fin = j.act_finance_report()
        if fin["expense"] or fin["income"]:
            line = f"В этом месяце потрачено {ru.money(fin['expense'], j.cfg.currency)}"
            if fin["budget_percent"] is not None:
                line += f" — {fin['budget_percent']}% бюджета"
            parts.append(line + ".")
        try:
            statuses = await j.act_project_status()
            parts += [project_line(s) for s in statuses if s.get("github") or s.get("health")]
        except Exception:  # noqa: BLE001 — брифинг не должен падать из-за сети
            pass
        rates = j.briefing.rates_phrase(await j.briefing.rates())
        if rates:
            parts.append(rates)
        if j.reminders.upcoming():
            k = len(j.reminders.upcoming())
            parts.append(f"Активных напоминаний: {k}.")
        parts.append("Хорошего дня, " + j.title + ".")
        text = " ".join(parts)
        return Reply(text, data={"weather": weather, "tasks": [t.as_dict() for t in today], "finance": fin})

    async def focus(self) -> "Reply":
        from .core import Reply
        j = self.j
        until = time.time() + FOCUS_MINUTES * 60
        j.focus_until = until
        j.reminders.add(f"{FOCUS_MINUTES} минут фокуса позади, {j.title}. Рекомендую перерыв на пять минут.", until)
        await j.hub.emit("focus", {"until": until, "minutes": FOCUS_MINUTES}, log_it=False)
        await j.changed("reminders")
        nxt = j.tasks.view(j.today(), "today")
        hint = f" Предлагаю начать с «{nxt[0].text}»." if nxt else ""
        return Reply(f"Режим фокуса на {FOCUS_MINUTES} минут. Уведомления приглушены.{hint}", kind="ok")

    async def evening(self) -> "Reply":
        from .core import Reply
        j, n = self.j, self.j.now()
        ref = n.date()
        done = j.tasks.done_on(ref)
        left = j.tasks.view(ref, "today")
        entries = [e for e in j.ledger.entries(ref.strftime("%Y-%m")) if e.date == ref.isoformat()]
        spent = -sum(e.amount for e in entries if e.amount < 0)
        earned = sum(e.amount for e in entries if e.amount > 0)
        cur = j.cfg.currency
        lines = [f"- Выполнено задач: {len(done)}" + (": " + "; ".join(t.text for t in done) if done else ""),
                 f"- Осталось на сегодня: {len(left)}" + (": " + "; ".join(t.text for t in left) if left else ""),
                 f"- Расходы: {ru.money(spent, cur)}; доходы: {ru.money(earned, cur)}"]
        path = j.memory.journal_path(n)
        j.vault.append_to_section(path, "Итоги дня", "\n".join(lines), header=f"# {ref.isoformat()}\n\n")
        await j.changed("memory")
        text = (f"Итоги дня, {j.title}: выполнено задач — {len(done)}, осталось — {len(left)}. "
                f"Потрачено {ru.money(spent, cur)}.")
        tomorrow = [t for t in j.tasks.view(ref, "all") if t.due == (ref + timedelta(days=1)).isoformat()]
        if tomorrow:
            text += f" Завтра ждут {len(tomorrow)} {ru.plural(len(tomorrow), 'задача', 'задачи', 'задач')}."
        return Reply(text + " Записал в журнал.", data={"done": len(done), "spent": spent})

    async def week(self) -> "Reply":
        from .core import Reply
        j, n = self.j, self.j.now()
        ref = n.date()
        start = ref - timedelta(days=ref.weekday())
        days = [start + timedelta(days=i) for i in range((ref - start).days + 1)]
        done = [t for d in days for t in j.tasks.done_on(d)]
        months = {d.strftime("%Y-%m") for d in days}
        isos = {d.isoformat() for d in days}
        entries = [e for m in months for e in j.ledger.entries(m) if e.date in isos]
        spent = -sum(e.amount for e in entries if e.amount < 0)
        by_cat: dict[str, int] = {}
        for e in entries:
            if e.amount < 0:
                by_cat[e.category] = by_cat.get(e.category, 0) - e.amount
        year, wk, _ = ref.isocalendar()
        path = f"{j.cfg.journal_dir}/Week-{year}-W{wk:02d}.md"
        cur = j.cfg.currency
        body = [f"# Неделя {wk}, {year}", "", f"Период: {start.isoformat()} — {ref.isoformat()}", "",
                "## Сделано", *([f"- [x] {t.text}" for t in done] or ["- пока ничего"]), "",
                "## Деньги", f"- Расходы: {ru.money(spent, cur)}",
                *[f"- {c}: {ru.money(v, cur)}" for c, v in sorted(by_cat.items(), key=lambda x: -x[1])], "",
                "## Открытые задачи", *[f"- [ ] {t.text}" for t in j.tasks.view(ref, "week")[:20]], "",
                "## Мысли и выводы", "- "]
        j.vault.write(path, "\n".join(body) + "\n")
        await j.changed("memory")
        return Reply(f"Обзор недели готов: выполнено {len(done)} задач, расходы {ru.money(spent, cur)}. "
                     f"Заметка — {path}.", data={"path": path})

    async def diagnostics(self) -> "Reply":
        from .core import Reply
        j = self.j
        d = j.diagnostics()
        parts = ["Диагностика систем. " + diagnostics.phrase(d)]
        parts.append(f"Память: {len(j.vault.list_files())} заметок в хранилище.")
        parts.append("Мозг Claude подключён." if j.brain.available
                     else "Мозг Claude не подключён — работаю на командах.")
        parts.append("Голос: " + ("выключен" if j.voice.muted else j.cfg.tts_engine) + ".")
        down = []
        for p in j.projects.list():
            h = await j.projects.check_health(p)
            if h is not None and not h.get("ok"):
                down.append(p.name)
        parts.append("Сервисы проектов отвечают." if not down else f"Не отвечают: {', '.join(down)}.")
        issues = diagnostics.problems(d, j.cfg.cpu_alert, j.cfg.ram_alert, j.cfg.disk_alert)
        parts.append("Все системы в норме." if not issues and not down else "Требуется внимание: " +
                     ", ".join(issues + down) + ".")
        return Reply(" ".join(parts), kind="warn" if issues or down else "ok", data=d)

    async def clean_slate(self) -> "Reply":
        from .core import Reply
        moved = self.j.tasks.archive_done(self.j.today())
        await self.j.changed("tasks")
        if not moved:
            return Reply("Чистить нечего — входящие и так в порядке.")
        return Reply(f"Протокол «Чистый лист»: перенёс {moved} выполненных задач в архив.", kind="ok")

    async def party(self) -> "Reply":
        from .core import Reply, project_line
        j = self.j
        statuses = await j.act_project_status()
        lines = [project_line(s) for s in statuses]
        deployable = [s["name"] for s in statuses if s.get("deploy_workflow") and s.get("repo")]
        text = "Протокол «Вечеринка»: все проекты на связи. " + " ".join(lines)
        if not deployable:
            return Reply(text + " Выкатывать нечего: ни у одного проекта нет deploy_workflow.", data=statuses)
        item = j.ask_confirm("deploy", f"Выкатить проекты: {', '.join(deployable)}", {"projects": deployable})
        return Reply(text + f" Выкатить {', '.join(deployable)}? Подтвердите.", kind="warn", confirm=item.as_dict(),
                     data=statuses)

    async def silence(self) -> "Reply":
        from .core import Reply
        self.j.voice.muted = True
        await self.j.hub.emit("voice", {"muted": True}, log_it=False)
        return Reply("Перехожу в беззвучный режим.", speech="")

    async def unmute(self) -> "Reply":
        from .core import Reply
        self.j.voice.muted = False
        await self.j.hub.emit("voice", {"muted": False}, log_it=False)
        return Reply(f"Снова на связи, {self.j.title}.")
