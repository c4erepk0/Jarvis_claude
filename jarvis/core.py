"""Ядро Jarvis: все сервисы и действия в одном месте.

Действия (`act_*`) вызывают и локальный разбор команд, и Claude (через инструменты), и REST API
дашборда — поэтому поведение везде одинаковое. Внешние и необратимые действия (задача для @claude,
запуск Claude Code, деплой, удаление из памяти) не выполняются сразу: они попадают в очередь
подтверждений, и владелец подтверждает их кнопкой или словом «подтверждаю».
"""
from __future__ import annotations

import logging
import random
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import diagnostics, intents, ru
from .briefing import Briefing
from .config import Config
from .finance import Ledger
from .github import GitHub, GitHubError
from .hub import Hub
from .memory import Memory
from .projects import Projects
from .reminders import Reminders
from .tasks import TaskBook
from .vault import Vault, VaultError, content_version
from .voice import Voice

log = logging.getLogger("jarvis.core")
Notifier = Callable[[str, str], Awaitable[None]]

ACKS = ["Слушаюсь, {t}.", "Сделано, {t}.", "Готово, {t}.", "Как скажете, {t}.", "Будет исполнено, {t}."]


@dataclass
class Reply:
    text: str
    speech: str | None = None
    kind: str = "info"               # info | ok | warn | error
    source: str = "local"            # local | claude | protocol | system
    confirm: dict | None = None      # отложенное действие, ждущее подтверждения
    data: Any = None

    def as_dict(self) -> dict:
        d = asdict(self)
        d["speech"] = self.speech if self.speech is not None else self.text
        return d


@dataclass
class PendingAction:
    id: str
    kind: str
    title: str
    params: dict
    created: float = field(default_factory=time.time)

    def as_dict(self) -> dict:
        return asdict(self)


class Jarvis:
    def __init__(self, cfg: Config, *, github: GitHub | None = None, briefing: Briefing | None = None,
                 llm: Any = None):
        self.cfg = cfg
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        self.vault = Vault(cfg.vault_path)
        self.tasks = TaskBook(self.vault, cfg.tasks_file, skip=(f"{cfg.jarvis_dir}/Conversations/",))
        self.ledger = Ledger(self.vault, cfg.finance_dir, cfg.currency)
        self.memory = Memory(self.vault, cfg.jarvis_dir, cfg.journal_dir)
        self.github = github or GitHub(cfg.github_token)
        self.projects = Projects(self.vault, cfg.projects_dir, self.github, claude_bin=cfg.claude_code_bin,
                                 permission_mode=cfg.claude_code_permission_mode,
                                 allowed_tools=cfg.claude_code_allowed_tools)
        self.voice = Voice(cfg.tts_engine, cfg.tts_voice, cfg.tts_rate, cfg.tts_pitch, cfg.data_dir / "tts",
                           cfg.piper_bin, cfg.piper_model)
        self.reminders = Reminders(self.vault, f"{cfg.jarvis_dir}/Reminders.md", ru.now(cfg.timezone).tzinfo)
        self.briefing = briefing or Briefing(cfg.latitude, cfg.longitude, cfg.city, cfg.timezone)
        self.hub = Hub()
        self.pending: dict[str, PendingAction] = {}
        self.notifiers: list[Notifier] = []
        self.focus_until: float | None = None
        self.git = None                 # GitSync, если хранилище живёт в GitHub-репозитории
        from .brain import Brain
        from .protocols import Protocols
        self.brain = Brain(self, client=llm)
        self.protocols = Protocols(self)

    # ---------- время ----------
    def now(self) -> datetime:
        return ru.now(self.cfg.timezone)

    def today(self) -> date:
        return self.now().date()

    @property
    def title(self) -> str:
        return self.cfg.user_title

    def ack(self) -> str:
        return random.choice(ACKS).format(t=self.title)

    def project_names(self) -> list[str]:
        return [p.name for p in self.projects.list()]

    async def close(self) -> None:
        await self.brain.close()
        await self.github.close()
        await self.projects.close()
        await self.briefing.close()

    # ---------- события и оповещения ----------
    async def log(self, text: str, *, journal: bool = True) -> None:
        await self.hub.emit("log", {"text": text})
        if journal:
            try:
                self.memory.log_event(text, self.now())
            except (OSError, VaultError):
                log.exception("не удалось записать в журнал")

    async def alert(self, text: str, level: str = "warn", *, speak: bool = True, telegram: bool = True) -> None:
        await self.hub.emit("alert", {"text": text, "level": level, "speak": speak})
        try:
            self.memory.log_event(f"⚠ {text}", self.now())
        except (OSError, VaultError):
            pass
        if telegram:
            for notify in self.notifiers:
                try:
                    await notify(text, level)
                except Exception:  # noqa: BLE001
                    log.exception("не удалось отправить оповещение")

    async def changed(self, what: str) -> None:
        """Сообщает дашбордам, какие данные обновить."""
        await self.hub.emit("refresh", {"what": what}, log_it=False)

    # ---------- подтверждения ----------
    def ask_confirm(self, kind: str, title: str, params: dict) -> PendingAction:
        item = PendingAction(uuid.uuid4().hex[:8], kind, title, params)
        self.pending[item.id] = item
        return item

    def latest_pending(self) -> PendingAction | None:
        fresh = [p for p in self.pending.values() if time.time() - p.created < 600]
        return max(fresh, key=lambda p: p.created) if fresh else None

    async def confirm(self, pid: str) -> Reply:
        item = self.pending.pop(pid, None)
        if not item:
            return Reply("Нет такого ожидающего действия — возможно, оно уже выполнено.", kind="warn")
        await self.hub.emit("pending", {"id": pid, "state": "confirmed"}, log_it=False)
        try:
            reply = await self._execute(item)
        except (GitHubError, ValueError, OSError) as e:
            await self.log(f"Не удалось выполнить «{item.title}»: {e}")
            self.brain.note(f"Действие «{item.title}» подтверждено, но не выполнено: {e}.")
            return Reply(f"Не получилось, {self.title}: {e}", kind="error")
        self.brain.note(f"Владелец подтвердил действие «{item.title}», результат: {reply.text}")
        return reply

    async def cancel(self, pid: str) -> Reply:
        item = self.pending.pop(pid, None)
        await self.hub.emit("pending", {"id": pid, "state": "cancelled"}, log_it=False)
        return Reply("Отменено." if item else "Отменять нечего.", kind="info")

    async def _execute(self, item: PendingAction) -> Reply:
        p = item.params
        when = self.now()
        if item.kind == "delegate_github":
            project = self._project(p["project"])
            issue = await self.projects.delegate_github(project, p["task"], when)
            await self.log(f"Задача для @claude в {project.name}: #{issue['number']}")
            await self.changed("projects")
            return Reply(f"Задача #{issue['number']} создана в {project.repo}. Claude возьмёт её в работу и "
                         f"откроет PR.", speech=f"Передал задачу Claude в {project.name}.", kind="ok",
                         data=issue)
        if item.kind == "delegate_local":
            project = self._project(p["project"])
            job = await self.projects.start_local(project, p["task"], when, self.hub.emit)
            await self.log(f"Claude Code запущен локально в {project.name}")
            return Reply(f"Claude Code работает над {project.name}. Ход работы — в панели «Мастерская».",
                         kind="ok", data=job.as_dict())
        if item.kind == "deploy":
            names = p.get("projects") or [p["project"]]
            done = []
            for name in names:
                project = self._project(name)
                await self.projects.deploy(project, when)
                done.append(project.name)
            await self.log(f"Деплой запущен: {', '.join(done)}")
            await self.changed("projects")
            return Reply(f"Деплой запущен: {', '.join(done)}. Слежу за GitHub Actions.", kind="ok")
        if item.kind == "forget":
            n = self.memory.forget(p["query"])
            await self.changed("memory")
            return Reply(f"Забыл: удалено фактов — {n}." if n else "Таких фактов в памяти нет.", kind="ok")
        return Reply("Неизвестное действие.", kind="error")

    def _project(self, name: str):
        project = self.projects.get(name)
        if not project:
            raise ValueError(f"проект «{name}» не найден в {self.cfg.projects_dir}/")
        return project

    # ---------- действия ----------
    async def act_add_task(self, text: str, due: str | None = None, priority: str | None = None,
                           project: str | None = None) -> dict:
        note, tags = None, []
        if project:
            proj = self.projects.get(project)
            if proj:
                tags = [proj.tag]
            else:
                tags = [project.lower()]
        due_d = date.fromisoformat(due) if due else None
        task = self.tasks.add(text, self.today(), due=due_d, priority=priority, tags=tags, note=note)
        await self.log(f"Новая задача: {task.text}")
        await self.changed("tasks")
        return task.as_dict()

    async def act_complete_task(self, task_id: str | None = None, query: str | None = None) -> dict:
        if not task_id and query:
            found = self.tasks.find(query)
            if not found:
                raise ValueError(f"не нашёл открытую задачу «{query}»")
            if len(found) > 1:
                return {"ambiguous": [t.as_dict() for t in found[:5]]}
            task_id = found[0].id
        if not task_id:
            raise ValueError("какую задачу отметить?")
        try:
            task = self.tasks.complete(task_id, self.today())
        except KeyError as e:
            raise ValueError(str(e)) from e
        await self.log(f"Выполнено: {task.text}")
        await self.changed("tasks")
        return task.as_dict()

    def act_list_tasks(self, view: str = "today", project: str | None = None) -> list[dict]:
        ref = self.today()
        tag = None
        if project:
            proj = self.projects.get(project)
            tag = proj.tag if proj else project
        if view == "tomorrow":
            tomorrow = ref + timedelta(days=1)
            items = [t for t in self.tasks.view(ref, "all", tag) if t.due == tomorrow.isoformat()]
        else:
            items = self.tasks.view(ref, view if view in ("today", "overdue", "week", "nodate", "all") else "today",
                                    tag)
        return [t.as_dict() for t in items]

    async def act_money(self, amount: int, category: str, note: str = "", day: str | None = None,
                        account: str = "") -> dict:
        d = date.fromisoformat(day) if day else self.today()
        entry = self.ledger.add(int(amount), category or "Прочее", note, d, account)
        word = "Доход" if amount > 0 else "Расход"
        await self.log(f"{word}: {ru.money(entry.amount, self.cfg.currency, signed=True)} · {entry.category} · {note}")
        await self.changed("finance")
        result = entry.as_dict()
        if amount < 0:
            warn = self.ledger.budget_alert(entry.category, d.strftime("%Y-%m"))
            if warn:
                result["budget_alert"] = warn
                await self.alert(warn, "warn", speak=False)
        return result

    def act_finance_report(self, month: str | None = None) -> dict:
        month = month or self.today().strftime("%Y-%m")
        return self.ledger.summary(month, self.today())

    async def act_remember(self, fact: str) -> dict:
        res = self.memory.remember(fact, self.now())
        if not res.get("duplicate"):
            await self.log(f"Запомнил: {res['text']}", journal=False)
            await self.changed("memory")
        return res

    def act_search(self, query: str, limit: int = 6) -> list[dict]:
        return [h.as_dict() for h in self.vault.search(query, limit)]

    # ---------- заметки в голограмме ----------
    def act_read_note(self, path: str) -> dict:
        text = self.vault.read(path)
        rel = self.vault.rel(self.vault.resolve(path))
        return {"path": rel, "title": self.vault.title_of(rel), "content": text[:NOTE_LIMIT],
                "version": content_version(text), "truncated": len(text) > NOTE_LIMIT,
                "editable": len(text) <= NOTE_LIMIT and Path(rel).suffix.lower() in (".md", ".txt")}

    async def act_open_note(self, query: str) -> dict:
        """Показать заметку на экране — в голограмме на всех открытых дашбордах."""
        path = self.vault.find_note(query)
        if not path:
            raise ValueError(f"не нашёл заметку «{query}»")
        await self.hub.emit("open_note", {"path": path}, log_it=False)
        return {"path": path, "title": self.vault.title_of(path)}

    async def act_save_note(self, path: str, text: str, base: str | None) -> dict:
        """Правка из голограммы: base — версия, с которой начали править (None — новая заметка)."""
        path = (path or "").strip()
        if path and not Path(path).suffix:
            path += ".md"
        if Path(path).suffix.lower() not in (".md", ".txt"):
            raise VaultError("в голограмме правятся только заметки .md и .txt")
        rel = self.vault.save(path, text.replace("\r\n", "\n"), base)
        await self.log(f"Заметка «{self.vault.title_of(rel)}» {'изменена' if base else 'создана'} в голограмме",
                       journal=False)
        await self.changed("notes")
        return {"path": rel, "version": content_version(self.vault.read(rel))}

    async def act_edit_note(self, path: str, find: str, replace: str) -> dict:
        """Точечная правка для мозга: заменить фрагмент, который встречается в заметке ровно один раз."""
        text = self.vault.read(path)
        count = text.count(find) if find else 0
        if count != 1:
            raise ValueError("фрагмент не найден — сначала прочитай заметку (note_read)" if not count else
                             f"фрагмент встречается {count} раз — возьми фрагмент длиннее, чтобы он был единственным")
        return await self.act_save_note(path, text.replace(find, replace, 1), content_version(text))

    async def act_note(self, text: str) -> dict:
        when = self.now()
        path = self.memory.journal_path(when)
        self.vault.append_to_section(path, "Заметки", f"- {when:%H:%M} {text.strip()}",
                                     header=f"# {when.date().isoformat()}\n\n")
        await self.changed("memory")
        return {"path": path}

    async def act_reminder(self, text: str, seconds: int) -> dict:
        at = time.time() + max(5, int(seconds))
        item = self.reminders.add(text, at)
        await self.changed("reminders")
        return {**item, "in_minutes": round(seconds / 60)}

    async def act_project_status(self, name: str | None = None) -> list[dict]:
        if name:
            return [await self.projects.status(self._project(name))]
        return await self.projects.status_all()

    def act_delegate(self, project: str, task: str, mode: str = "github") -> PendingAction:
        proj = self._project(project)
        if mode == "local":
            reason = self.projects.can_run_local(proj)
            if reason:
                raise ValueError(reason)
            return self.ask_confirm("delegate_local", f"Claude Code локально в {proj.name}: {task}",
                                    {"project": proj.name, "task": task})
        if not proj.repo:
            raise ValueError(f"у проекта {proj.name} не указан repo")
        return self.ask_confirm("delegate_github", f"Задача для @claude в {proj.repo}: {task}",
                                {"project": proj.name, "task": task})

    def act_deploy(self, project: str) -> PendingAction:
        proj = self._project(project)
        if not proj.deploy_workflow:
            raise ValueError(f"у проекта {proj.name} не задан deploy_workflow")
        return self.ask_confirm("deploy", f"Деплой {proj.name} ({proj.deploy_workflow})", {"project": proj.name})

    # ---------- главный вход ----------
    async def handle(self, text: str, source: str = "dashboard", depth: int = 0, client: str | None = None,
                     note: str | None = None) -> Reply:
        """note — заметка, открытая сейчас в голограмме: «эта заметка» в просьбе — она."""
        text = (text or "").strip()
        if not text:
            return Reply("Слушаю вас, " + self.title + ".")
        await self.hub.emit("heard", {"text": text, "source": source, "client": client}, log_it=False)
        intent = intents.parse(text, self.today(), self.project_names(), self.cfg.wake_word)
        reply: Reply | None = None
        try:
            if intent and intent.name in ("confirm", "cancel"):
                pending = self.latest_pending()
                if pending:
                    reply = await (self.confirm(pending.id) if intent.name == "confirm" else self.cancel(pending.id))
                elif not self.brain.available:
                    reply = Reply("Подтверждать нечего, " + self.title + ".")
            elif intent and (self.cfg.local_first or not self.brain.available or intent.name == "protocol"):
                reply = await self._run_intent(intent, depth)
        except (ValueError, VaultError) as e:
            reply = Reply(f"Не вышло, {self.title}: {e}", kind="error")
        if reply is None:
            if self.brain.available:
                reply = await self.brain.ask(text, source, note=note)
            else:
                reply = Reply(
                    f"Без подключения к модели я понимаю только команды, {self.title}. Скажите «что ты умеешь» — "
                    f"перечислю. Чтобы я понимал свободную речь, подключите GigaChat, YandexGPT или Claude "
                    f"(ключ в .env, см. docs/brain.md).",
                    kind="warn")
        if reply.confirm is None:
            pending = self.latest_pending()
            if pending and time.time() - pending.created < 2:
                reply.confirm = pending.as_dict()
        if depth == 0 and source != "protocol":
            try:
                self.memory.log_dialog(text, reply.text, self.now(), source)
            except (OSError, VaultError):
                log.exception("не удалось сохранить разговор")
        if depth == 0:
            await self.hub.emit("reply", {**reply.as_dict(), "request": text, "via": source, "client": client},
                                log_it=False)
        return reply

    async def _run_intent(self, it: intents.Intent, depth: int) -> Reply:
        a, t = it.args, self.title
        if it.name == "greet":
            hour = self.now().hour
            return Reply(f"{ru.greeting(hour)}, {t}. Все системы в норме. Чем могу помочь?")
        if it.name == "help":
            return Reply(HELP.format(t=t, wake=self.cfg.wake_word.capitalize()), speech=(
                f"Я веду ваши задачи, финансы, проекты и память в Obsidian, {t}. Список команд — на экране."))
        if it.name == "time":
            n = self.now()
            return Reply(f"Сейчас {n:%H:%M}, {ru.WEEKDAYS[n.weekday()]}, {n.day} {ru.MONTHS_GEN[n.month - 1]}.")
        if it.name == "weather":
            w = await self.briefing.weather()
            return Reply(self.briefing.weather_phrase(w), data=w)
        if it.name == "currency":
            r = await self.briefing.rates()
            return Reply(self.briefing.rates_phrase(r) or "Курсы сейчас недоступны.", data=r)
        if it.name == "protocol":
            return await self.protocols.run(a["name"], depth)
        if it.name == "task_add":
            if not a.get("text"):
                return Reply("Что записать в задачу, " + t + "?", kind="warn")
            task = await self.act_add_task(a["text"], a.get("due"), a.get("priority"), a.get("project"))
            when = f" на {ru.human_date(date.fromisoformat(task['due']), self.today())}" if task.get("due") else ""
            return Reply(f"{self.ack()} Задача «{task['text']}» добавлена{when}.", kind="ok", data=task)
        if it.name == "task_done":
            res = await self.act_complete_task(query=a["query"])
            if "ambiguous" in res:
                names = "; ".join(x["text"] for x in res["ambiguous"])
                return Reply(f"Нашёл несколько задач: {names}. Уточните, какую закрыть.", kind="warn",
                             data=res)
            return Reply(f"Отметил выполненной: «{res['text']}». Отличная работа, {t}.", kind="ok", data=res)
        if it.name == "tasks_list":
            return self._tasks_reply(a.get("view", "today"), a.get("project"))
        if it.name in ("expense", "income"):
            res = await self.act_money(a["amount"], a["category"], a.get("note", ""))
            s = f"{self.ack()} Записал {'доход' if it.name == 'income' else 'расход'} " \
                f"{ru.money(abs(res['amount']), self.cfg.currency)} — {res['category']}."
            if res.get("budget_alert"):
                s += " " + res["budget_alert"]
            return Reply(s, kind="warn" if res.get("budget_alert") else "ok", data=res)
        if it.name == "finance_report":
            return self._finance_reply(a.get("period", "month"))
        if it.name == "remember":
            res = await self.act_remember(a["fact"])
            if res.get("duplicate"):
                return Reply(f"Я это уже помню, {t}.")
            return Reply(f"Запомнил, {t}.", kind="ok", data=res)
        if it.name == "forget":
            item = self.ask_confirm("forget", f"Удалить из памяти факты про «{a['query']}»", {"query": a["query"]})
            return Reply(f"Удалить из памяти всё про «{a['query']}»? Подтвердите.", kind="warn",
                         confirm=item.as_dict())
        if it.name == "note_open":
            res = await self.act_open_note(a["query"])
            return Reply(f"Открываю «{res['title']}» в голограмме, {t}.", kind="ok", data={"open_note": res["path"]})
        if it.name == "recall":
            return self._recall_reply(a.get("query", ""))
        if it.name == "note":
            res = await self.act_note(a["text"])
            return Reply(f"Записал в журнал, {t}.", kind="ok", data=res)
        if it.name == "reminder":
            res = await self.act_reminder(a["text"], a["seconds"])
            mins = max(1, res["in_minutes"])
            return Reply(f"Напомню через {mins} {ru.plural(mins, 'минуту', 'минуты', 'минут')}: «{res['text']}».",
                         kind="ok", data=res)
        if it.name == "project_status":
            return await self._projects_reply(a.get("project"))
        if it.name == "delegate":
            item = self.act_delegate(a["project"], a["task"], a.get("mode", "github"))
            where = "запущу Claude Code на этом компьютере" if item.kind == "delegate_local" else \
                "создам задачу для @claude на GitHub"
            return Reply(f"Для {item.params['project']} {where}: «{a['task']}». Подтверждаете?", kind="warn",
                         confirm=item.as_dict())
        if it.name == "deploy":
            item = self.act_deploy(a["project"])
            return Reply(f"Запустить деплой {item.params['project']}? Это затронет боевой сервер.", kind="warn",
                         confirm=item.as_dict())
        return Reply("Команда не распознана.", kind="warn")

    # ---------- ответы-сводки ----------
    def _tasks_reply(self, view: str, project: str | None) -> Reply:
        items = self.act_list_tasks(view, project)
        label = {"today": "на сегодня", "overdue": "просроченных", "week": "на неделю", "tomorrow": "на завтра",
                 "all": "открытых", "nodate": "без срока"}.get(view, "")
        scope = f" по {project}" if project else ""
        if not items:
            return Reply(f"Задач {label}{scope} нет, {self.title}. Можно выдохнуть.", data=items)
        names = [x["text"] for x in items[:7]]
        more = f" и ещё {len(items) - 7}" if len(items) > 7 else ""
        n = len(items)
        head = f"{n} {ru.plural(n, 'задача', 'задачи', 'задач')} {label}{scope}: "
        return Reply(head + "; ".join(names) + more + ".", data=items)

    def _finance_reply(self, period: str) -> Reply:
        cur = self.cfg.currency
        if period == "today":
            iso = self.today().isoformat()
            items = [e for e in self.ledger.entries(self.today().strftime("%Y-%m")) if e.date == iso]
            spent = -sum(e.amount for e in items if e.amount < 0)
            return Reply(f"Сегодня потрачено {ru.money(spent, cur)} ({len(items)} операций).",
                         data=[e.as_dict() for e in items])
        s = self.act_finance_report()
        text = f"В этом месяце расходы {ru.money(s['expense'], cur)}, доходы {ru.money(s['income'], cur)}."
        if s["budget_total"]:
            text += f" Бюджет израсходован на {s['budget_percent']}%."
        top = [c for c in s["categories"] if c["spent"]][:3]
        if top:
            text += " Больше всего: " + ", ".join(f"{c['category']} — {ru.money(c['spent'], cur)}" for c in top) + "."
        if s["forecast"] and s["budget_total"] and s["forecast"] > s["budget_total"]:
            text += f" При таком темпе к концу месяца выйдет {ru.money(s['forecast'], cur)} — выше бюджета."
        return Reply(text, data=s)

    def _recall_reply(self, query: str) -> Reply:
        if not query:
            facts = self.memory.facts()
            profile = self.memory.profile()
            if not facts and not profile:
                return Reply(f"Пока я знаю о вас немного, {self.title}. Скажите «запомни, что…».")
            lines = [f["text"] for f in facts[-8:]]
            text = "Вот что я помню: " + "; ".join(lines) + "." if lines else "Профиль заполнен, фактов пока нет."
            return Reply(text, data={"facts": facts})
        hits = self.act_search(query, 5)
        if not hits:
            return Reply(f"В заметках ничего не нашёл про «{query}».", data=[])
        titles = ", ".join(h["title"] for h in hits[:4])
        return Reply(f"Нашёл в заметках: {titles}. {hits[0]['snippet']}", data=hits)

    async def _projects_reply(self, name: str | None) -> Reply:
        statuses = await self.act_project_status(name)
        if not statuses:
            return Reply(f"Проектов пока нет. Создайте заметку в {self.cfg.projects_dir}/ с полем repo.")
        parts = [project_line(s) for s in statuses]
        return Reply(" ".join(parts), data=statuses)

    # ---------- состояние для дашборда ----------
    async def state(self, with_projects: bool = False) -> dict:
        ref = self.today()
        n = self.now()
        st: dict[str, Any] = {
            "now": n.isoformat(), "title": self.title, "name": self.cfg.user_name,
            "llm": self.brain.available, "brain": self.brain.title or None, "model": self.brain.model,
            "voice": {"engine": self.cfg.tts_engine, "server": self.voice.server_side, "muted": self.voice.muted,
                      "wake_word": self.cfg.wake_word},
            "tasks": {"summary": self.tasks.summary(ref), "today": self.act_list_tasks("today"),
                      "week": self.act_list_tasks("week")[:20], "nodate": self.act_list_tasks("nodate")[:15],
                      "done_today": [t.as_dict() for t in self.tasks.done_on(ref)]},
            "finance": self.act_finance_report(),
            "memory": {"facts": self.memory.facts()[-12:], "notes": len(self.vault.list_files())},
            "projects": [p.as_dict() for p in self.projects.list()],
            "pending": [p.as_dict() for p in self.pending.values()],
            "reminders": self.reminders.upcoming(),
            "protocols": self.protocols.list(),
            "focus_until": self.focus_until,
            "events": self.hub.recent(),
            "telegram": self.cfg.telegram_enabled,
            "vault": str(self.vault.root),
            "vault_git": ({"remote": self.git.remote.split("github.com/")[-1].removesuffix(".git"),
                           "last_sync": self.git.last_sync, "error": self.git.last_error} if self.git else None),
        }
        if with_projects:
            st["projects_status"] = await self.act_project_status()
        return st

    def diagnostics(self) -> dict:
        return diagnostics.snapshot(str(self.vault.root))


CI_WORDS = {"success": "сборка зелёная", "failure": "сборка упала", "cancelled": "сборка отменена",
            "timed_out": "сборка зависла", "skipped": "сборка пропущена", "action_required": "сборка ждёт одобрения"}


def project_line(s: dict) -> str:
    gh = s.get("github") or {}
    ci = gh.get("ci") or {}
    bits = [f"{s['name']}:"]
    if ci:
        if ci.get("status") != "completed":
            bits.append("сборка идёт")
        else:
            bits.append(CI_WORDS.get(ci.get("conclusion") or "", "сборка с ошибкой"))
    elif s.get("github_error"):
        bits.append(s["github_error"])
    if gh:
        prs, issues = len(gh.get("pulls") or []), len(gh.get("issues") or [])
        bits.append(f"PR открыто {prs}, задач {issues}")
    h = s.get("health")
    if h:
        bits.append("сервис в сети" if h.get("ok") else "сервис НЕ отвечает")
    stats = s.get("stats") or {}
    if stats and not stats.get("error") and "users" in stats:
        bits.append(f"пользователей {stats['users']}")
        if stats.get("new_users_24h"):
            bits.append(f"новых за сутки {stats['new_users_24h']}")
        if stats.get("stars_24h"):
            bits.append(f"звёзд за сутки {stats['stars_24h']}")
        waiting = (stats.get("open_reports") or 0) + (stats.get("pending_devs") or 0) + (stats.get("pending_apps") or 0)
        if waiting:
            bits.append(f"ждут модерации {waiting}")
    return (" ".join(bits[:1]) + " " + ", ".join(bits[1:]) + ".") if len(bits) > 1 else f"{s['name']}: нет данных."


NOTE_LIMIT = 200_000   # больше — показываем, но не даём править (чтобы не обрезать заметку при сохранении)

HELP = """Вот что я умею, {t}:
• «{wake}, доброе утро» — брифинг: погода, задачи, финансы, проекты, курс.
• «Добавь задачу написать оферту для IPAStore в пятницу, срочно» · «задачи на сегодня» · «выполнил …».
• «Потратил 450 на кофе» · «получил 50 000 зарплата» · «сколько я потратил в этом месяце».
• «Напомни через 20 минут позвонить» · «запомни, что …» · «найди в заметках …» · «заметка: …».
• «Открой заметку IPAStore» — покажу её в голограмме; там же её можно поправить.
• «Статус проектов» · «поручи IPAStore: добавить экспорт в CSV» (задача для @claude) ·
  «поручи локально Jarvis: …» (Claude Code на этом компьютере) · «задеплой IPAStore».
• Протоколы: Утро, Фокус, Итоги дня, Неделя, Диагностика, Чистый лист, Вечеринка, Тишина и ваши из Obsidian.
• С ключом Claude — свободный разговор, поиск в интернете и анализ фото (чеков, документов)."""
