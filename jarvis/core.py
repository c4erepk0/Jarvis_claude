"""Ядро Atom: все сервисы и действия в одном месте.

Действия (`act_*`) вызывают и локальный разбор команд, и Claude (через инструменты), и REST API
дашборда — поэтому поведение везде одинаковое. Внешние и необратимые действия (задача для @claude,
запуск Claude Code, деплой, удаление из памяти) не выполняются сразу: они попадают в очередь
подтверждений, и владелец подтверждает их кнопкой или словом «подтверждаю».
"""
from __future__ import annotations

import asyncio
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
from .apps import catalog, set_in_catalog
from .meetings import OP_TAG, for_operator, meeting_text, meetings
from .operators import BUILTIN_APPS, TEAM_DIR, Operators
from .tasks import TaskBook as _TaskBook
from .places import Places
from .assets import Portfolio, Quotes
from .finance import Ledger, analytics
from .github import GitHub, GitHubError
from .hub import Hub
from .memory import Memory
from .notes import Notes, note_tags
from .projects import STATUSES, Projects
from .reminders import Reminders
from .settings import Settings
from .updater import Updater, UpdateError
from .synthesis import description as synthesis_description, synthesize
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


def _kopecks(value: Any) -> int:
    try:
        return int(round(float(str(value or "0").replace(" ", "").replace(",", ".").replace("−", "-")) * 100))
    except ValueError:
        raise ValueError("сумма должна быть числом") from None


class Jarvis:
    def __init__(self, cfg: Config, *, github: GitHub | None = None, briefing: Briefing | None = None,
                 llm: Any = None, quotes: Quotes | None = None):
        self.cfg = cfg
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        self.vault = Vault(cfg.vault_path)
        # личные задачи операторов (Команда/<Имя>/) — их дело, в списки владельца не попадают
        self.tasks = TaskBook(self.vault, cfg.tasks_file, skip=(f"{cfg.jarvis_dir}/Conversations/", f"{TEAM_DIR}/"))
        self.ledger = Ledger(self.vault, cfg.finance_dir, cfg.currency)
        self.memory = Memory(self.vault, cfg.jarvis_dir, cfg.journal_dir)
        self.notes = Notes(self.vault)
        self.github = github or GitHub(cfg.github_token)
        self.projects = Projects(self.vault, cfg.projects_dir, self.github, claude_bin=cfg.claude_code_bin,
                                 permission_mode=cfg.claude_code_permission_mode,
                                 allowed_tools=cfg.claude_code_allowed_tools)
        self.portfolio = Portfolio(self.vault, cfg.finance_dir, cfg.currency, self.projects)
        self.quotes = quotes or Quotes()
        self.places = Places(self.vault, f"{cfg.jarvis_dir}/Places.md")
        self.operators = Operators(cfg.data_dir, self.vault, f"{cfg.jarvis_dir}/Chat")
        self.voice = Voice(cfg.tts_engine, cfg.tts_voice, cfg.tts_rate, cfg.tts_pitch, cfg.data_dir / "tts",
                           cfg.piper_bin, cfg.piper_model)
        self.reminders = Reminders(self.vault, f"{cfg.jarvis_dir}/Reminders.md", ru.now(cfg.timezone).tzinfo)
        self.briefing = briefing or Briefing(cfg.latitude, cfg.longitude, cfg.city, cfg.timezone)
        self.hub = Hub()
        self.pending: dict[str, PendingAction] = {}
        self.notifiers: list[Notifier] = []
        self.focus_until: float | None = None
        self.git = None                 # GitSync, если хранилище живёт в GitHub-репозитории
        self.settings = Settings(cfg.data_dir)
        self.updater = Updater(token=cfg.github_token, branch=self.settings.data["update"].get("branch", ""))
        self.restart_hook: Callable[[], None] | None = None   # ставит __main__: остановиться и запуститься заново
        self.restart_requested = False
        self.started = time.time()
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
        await self.quotes.close()

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
        except (GitHubError, UpdateError, ValueError, OSError) as e:
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
        if item.kind == "trash":
            res = await self.act_trash_note(p["path"])
            name = self.vault.title_of(p["path"])
            return Reply(f"Заметка «{name}» — в корзине Obsidian ({res['trash']}).", kind="ok")
        if item.kind == "update":
            res = await self.updater.apply()
            if not res["updated"]:
                return Reply(f"Обновлять нечего, {self.title}: {res['reason']}.", kind="info")
            await self.log(f"Atom обновлён: {res['from']} → {res['to']}{' (с зависимостями)' if res['deps'] else ''}")
            self.request_restart(delay=1.5)
            return Reply(f"Обновлено до {res['to']}. Перезапускаюсь — через несколько секунд страница переподключится.",
                         kind="ok", data=res)
        if item.kind == "forget":
            n = self.memory.forget(p["query"])
            await self.changed("memory")
            return Reply(f"Забыл: удалено фактов — {n}." if n else "Таких фактов в памяти нет.", kind="ok")
        return Reply("Неизвестное действие.", kind="error")

    # ---------- перезапуск и автообновление ----------
    def request_restart(self, delay: float = 1.0) -> bool:
        """Перезапустить Atom (новые настройки, обновление). Без __main__ (тесты) — только флаг."""
        self.restart_requested = True
        if not self.restart_hook:
            return False
        asyncio.get_running_loop().call_later(delay, self.restart_hook)
        return True

    async def auto_update_loop(self) -> None:
        """Автообновление (включает владелец): раз в N часов — проверить ветку и обновиться, если есть новое."""
        await asyncio.sleep(120)                                 # дать спокойно запуститься
        while True:
            u = self.settings.data["update"]
            if u.get("auto") and self.updater.available:
                try:
                    res = await self.updater.apply()
                    if res["updated"]:
                        await self.alert(f"Atom обновился сам: {res['from']} → {res['to']}. Перезапускаюсь.", "info",
                                         speak=False)
                        self.request_restart(delay=2)
                        return
                except UpdateError as e:
                    log.warning("автообновление: %s", e)
                    await self.log(f"Автообновление не удалось: {e}", journal=False)
            await asyncio.sleep(max(1, int(u.get("hours") or 6)) * 3600)

    def _project(self, name: str):
        project = self.projects.get(name)
        if not project:
            raise ValueError(f"проект «{name}» не найден в {self.cfg.projects_dir}/")
        return project

    # ---------- действия ----------
    async def act_add_task(self, text: str, due: str | None = None, priority: str | None = None,
                           project: str | None = None, to_note: bool = False) -> dict:
        """to_note — записать задачу в раздел «Задачи» заметки проекта, а не во входящие."""
        note, tags = None, []
        if project:
            proj = self.projects.get(project)
            if proj:
                tags = [proj.tag]
                note = proj.note if to_note else None
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

    def act_finance_analytics(self, months: int = 6) -> dict:
        return analytics(self.ledger, self.today(), months)

    async def act_assets(self, record: bool = True) -> dict:
        """Активы и долги с котировками; record — строка дня в Finance/Capital.md (динамика капитала)."""
        assets, debts = self.portfolio.read()
        quotes = await self.quotes.get(assets)
        report = self.portfolio.valuate(assets, debts, quotes, self.today())
        report["history"] = self.portfolio.record(self.today(), report) if record else self.portfolio.history()
        return report

    async def act_asset_add(self, action: str, data: dict) -> dict:
        """action: init — создать Finance/Assets.md; asset — строка актива; debt — строка долга."""
        if action == "init":
            path = self.portfolio.init()
            await self.changed("finance")
            return {"path": path}
        if action == "debt":
            res = self.portfolio.add_debt(str(data.get("name") or ""), _kopecks(data.get("amount")),
                                          str(data.get("due") or ""), str(data.get("note") or ""))
            await self.log(f"Долг записан: {res['name']} — {ru.money(res['amount'], self.cfg.currency)}")
        else:
            qty = str(data.get("qty") or "1").replace(",", ".").replace(" ", "")
            try:
                qty_f = float(qty)
            except ValueError:
                raise ValueError("количество должно быть числом") from None
            price = data.get("price")
            res = self.portfolio.add_asset(str(data.get("name") or ""), str(data.get("kind") or ""), qty_f,
                                           _kopecks(data.get("buy")), str(data.get("ticker") or ""),
                                           str(data.get("date") or ""),
                                           _kopecks(price) if price not in (None, "") else None)
            await self.log(f"Актив записан: {res['name']}")
        await self.changed("finance")
        return res

    # ---------- операторы, поручения, встречи ----------
    def act_meetings(self, op_slug: str | None = None) -> dict:
        return meetings(self.tasks.all(), self.today().isoformat(), op_slug=op_slug)

    def operator_tag(self, op_id: str | None) -> str | None:
        if not op_id:
            return None
        op = self.operators.get(op_id)
        if not op:
            raise ValueError("нет такого оператора")
        return OP_TAG + op["slug"]

    async def act_assign(self, kind: str, data: dict, by: str = "owner") -> dict:
        """kind: task — задача (оператору — с тегом #оператор/<имя>), meeting — встреча (#встреча, 🕒 время, 📍 место)."""
        tag = self.operator_tag(str(data.get("operator") or "") or None)
        due = None
        if data.get("due"):
            try:
                due = date.fromisoformat(str(data["due"]))
            except ValueError:
                raise ValueError("дата — в виде ГГГГ-ММ-ДД") from None
        tags = [tag] if tag else []
        if kind == "meeting":
            text = meeting_text(str(data.get("title") or data.get("text") or ""), str(data.get("time") or ""),
                                str(data.get("place") or ""))
            tags = ["встреча", *tags]
        else:
            text = str(data.get("text") or "").strip()
        task = self.tasks.add(text, self.today(), due=due, priority=data.get("priority") or None, tags=tags)
        who = "Оператор" if by != "owner" else "Владелец"
        await self.log(f"{who}: {'встреча' if kind == 'meeting' else 'задача'} «{task.text}»"
                       f"{' → ' + tag.split('/', 1)[1] if tag else ''}")
        await self.changed("tasks")
        return task.as_dict()

    # ---------- кабинет оператора ----------
    def op_book(self, op: dict) -> "_TaskBook":
        """Личный список задач оператора: Команда/<Имя>/Задачи.md (и задачи в его заметках)."""
        folder = self.operators.folder(op)
        return _TaskBook(self.vault, f"{folder}/Задачи.md", only=f"{folder}/")

    def op_shared(self, op: dict) -> list:
        """Общие с оператором проекты (их выбирает владелец) и проекты приложений, которыми он управляет."""
        names = {n.lower() for n in op.get("projects", [])}
        managed = {a["id"] for a in op.get("apps", []) if a.get("level") == "manage"}
        return [p for p in self.projects.list() if p.name.lower() in names or p.note in managed]

    # ---------- приложения и доверенные заметки оператора ----------
    def op_apps(self, op: dict) -> list[dict]:
        """Приложения, к которым владелец дал доступ: из каталога и встроенные (карта)."""
        levels = {a["id"]: a["level"] for a in op.get("apps", [])}
        if not levels:
            return []
        out = [{"id": k, "name": BUILTIN_APPS[k], "kind": "builtin", "level": levels[k], "icon": "🗺",
                "description": "Поиск мест, маршруты и навигация", "url": "", "repo": "", "note": ""}
               for k in BUILTIN_APPS if k in levels]
        for a in catalog(self.vault, self.projects)["apps"]:
            if a["note"] in levels:
                out.append({"id": a["note"], "name": a["name"], "kind": a["kind"], "level": levels[a["note"]],
                            "icon": a["icon"], "description": a["description"], "url": a["url"], "repo": a["repo"],
                            "note": a["note"], "status_label": a["status_label"]})
        return out

    def op_trusted(self, op: dict, rel: str) -> bool | None:
        """Доверенная заметка? None — нет доступа, False — только чтение, True — можно править."""
        best = None
        for n in op.get("notes", []):
            p = n["path"]
            if rel == p or rel.startswith(p + "/"):
                best = bool(best) or n["edit"]
        if any(a["level"] == "manage" and a["id"] == rel for a in op.get("apps", [])):
            best = True                                       # управляет приложением — правит его заметку
        return best

    def op_access(self, op: dict, path: str, write: bool = False) -> str:
        """Путь заметки, если оператору можно её читать (write — и править): своя папка или доверенная."""
        folder = self.operators.folder(op)
        bare = "/" not in path and not self.vault.exists(path)          # «Звонки.md» — из своей папки
        rel = self.vault.rel(self.vault.resolve(f"{folder}/{path}" if bare else path))
        if not rel.endswith(".md"):
            raise PermissionError("открыть можно только заметку .md")
        if rel.startswith(folder + "/"):
            return rel
        access = self.op_trusted(op, rel)
        if access is None:
            raise PermissionError("эта заметка вам не открыта")
        if write and not access:
            raise PermissionError("эту заметку можно только читать")
        return rel

    def op_shared_notes(self, op: dict) -> list[dict]:
        """Доверенные заметки по одной (папка раскрывается в заметки внутри)."""
        out: dict[str, dict] = {}
        for n in op.get("notes", []):
            try:
                target = self.vault.resolve(n["path"])
            except VaultError:
                continue
            files = self.vault.list_files(n["path"]) if target.is_dir() else [n["path"]] if target.is_file() else []
            for rel in files:
                if not rel.endswith(".md"):
                    continue
                edit = bool(self.op_trusted(op, rel))
                st = self.vault.resolve(rel).stat()
                out[rel] = {"path": rel, "title": self.vault.title_of(rel), "edit": edit, "mtime": int(st.st_mtime),
                            "folder": rel.rsplit("/", 1)[0] if "/" in rel else "", "from": n["path"]}
        return sorted(out.values(), key=lambda x: (x["folder"], x["title"].lower()))

    def _project_tasks(self, project) -> list:
        folder = self.projects.folder_of(project)
        return [t for t in self.tasks.all() if project.tag in t.tags or t.path == project.note
                or t.path.startswith(folder + "/")]

    def operator_tasks(self, op: dict, view: str = "all") -> dict:
        """Кабинет: порученное (или все задачи владельца — право tasks_all) и личные задачи. Встречи — отдельно."""
        view = view if view in ("today", "week", "overdue", "nodate", "all") else "all"
        ref = self.today()
        assigned = self.tasks.view(ref, view)
        if "tasks_all" not in op.get("perms", []):
            assigned = for_operator(assigned, op["slug"])
        assigned = [t.as_dict() for t in assigned if "встреча" not in t.tags]
        book = self.op_book(op)
        personal = [t.as_dict() for t in book.view(ref, view)]
        iso = ref.isoformat()
        done = [t.as_dict() for t in [*self.tasks.done_on(ref), *book.done_on(ref)]
                if "встреча" not in t.tags and self.operator_can_touch(op, t.id) and t.done == iso]
        return {"assigned": assigned, "personal": personal, "done_today": done}

    def operator_can_touch(self, op: dict, task_id: str) -> bool:
        folder = self.operators.folder(op) + "/"
        if task_id.startswith(folder):
            return True                                         # личная задача
        task = next((t for t in self.tasks.all() if t.id == task_id), None)
        if not task:
            return False
        mine = OP_TAG + op["slug"] in task.tags
        if "встреча" in task.tags:
            return mine or "meetings_all" in op.get("perms", [])
        if mine or "tasks_all" in op.get("perms", []):
            return True
        return any(task.id in {t.id for t in self._project_tasks(p)} for p in self.op_shared(op))

    def op_set_status(self, op: dict, task_id: str, status: str):
        if not self.operator_can_touch(op, task_id):
            raise PermissionError("эта задача не ваша")
        folder = self.operators.folder(op) + "/"
        book = self.op_book(op) if task_id.startswith(folder) else self.tasks
        return book.set_status(task_id, status, self.today())

    async def op_add_task(self, op: dict, text: str, due: str | None = None, project: str | None = None) -> dict:
        d = None
        if due:
            try:
                d = date.fromisoformat(due)
            except ValueError:
                raise ValueError("дата — в виде ГГГГ-ММ-ДД") from None
        if project:                                       # задача в общий проект — с правом tasks_assign
            if "tasks_assign" not in op.get("perms", []):
                raise PermissionError("ставить задачи в проекты вам не разрешено")
            proj = next((p for p in self.op_shared(op) if p.name.lower() == project.strip().lower()), None)
            if not proj:
                raise PermissionError("этот проект вам не открыт")
            task = self.tasks.add(text, self.today(), due=d, tags=[proj.tag])
            await self.log(f"{op['name']}: задача в проект {proj.name} — {task.text}")
            await self.changed("tasks")
            return task.as_dict()
        book = self.op_book(op)
        if not self.vault.exists(book.inbox):
            self.vault.write(book.inbox, f"# Задачи — {op['name']}\n\n"
                                         "Личный список. Поручения владельца — в кабинете.\n\n")
        task = book.add(text, self.today(), due=d)
        await self.changed("tasks")
        return task.as_dict()

    def op_projects(self, op: dict) -> list[dict]:
        out = []
        for p in self.op_shared(op):
            tasks = self._project_tasks(p)
            open_ = [t.as_dict() for t in tasks if t.is_open and "встреча" not in t.tags]
            done = sum(1 for t in tasks if t.status == "done")
            total = done + len(open_)
            out.append({"name": p.name, "status": p.status, "description": p.description, "tag": p.tag,
                        "tasks": open_, "progress": {"done": done, "total": total,
                                                     "percent": round(done * 100 / total) if total else 0}})
        return out

    # личные заметки оператора — только внутри его папки
    def op_path(self, op: dict, path: str) -> str:
        folder = self.operators.folder(op)
        rel = self.vault.rel(self.vault.resolve(path if "/" in path else f"{folder}/{path}"))
        if not rel.startswith(folder + "/") or not rel.endswith(".md"):
            raise PermissionError("это не ваша заметка")
        return rel

    def op_notes(self, op: dict) -> list[dict]:
        folder = self.operators.folder(op)
        out = []
        for rel in self.vault.list_files(folder) if self.vault.resolve(folder).is_dir() else []:
            st = self.vault.resolve(rel).stat()
            text = self.vault.read(rel)
            body = next((ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith(("#", "---"))), "")
            out.append({"path": rel, "title": self.vault.title_of(rel), "mtime": int(st.st_mtime), "size": st.st_size,
                        "snippet": body[:140], "tasks": rel.endswith("/Задачи.md")})
        return sorted(out, key=lambda n: (not n["tasks"], -n["mtime"]))

    async def act_chat(self, op_id: str, sender: str, text: str) -> dict:
        msg = self.operators.post(op_id, sender, text, self.now())
        op = self.operators.get(op_id)
        await self.hub.emit("chat", {"op": op_id, "name": op["name"], "message": msg}, log_it=False)
        if sender != "owner":
            await self.log(f"Чат · {op['name']}: {msg['text'][:120]}", journal=False)
        return msg

    async def act_place(self, action: str, data: dict) -> dict:
        """action: add — сохранить место (то же название — обновить), remove — убрать."""
        if action == "remove":
            ok = self.places.remove(str(data.get("name") or ""))
            if not ok:
                raise ValueError("такого места нет")
        else:
            p = self.places.add(str(data.get("name") or ""), data.get("lat"), data.get("lon"),
                                str(data.get("address") or ""), str(data.get("category") or ""),
                                str(data.get("note") or ""))
            await self.log(f"Место сохранено: {p['name']}", journal=False)
        await self.changed("places")
        return {"places": self.places.list()}

    def act_apps(self) -> dict:
        return catalog(self.vault, self.projects)

    async def act_app_catalog(self, name: str, on: bool = True) -> dict:
        res = set_in_catalog(self.vault, self.projects, name, on)
        await self.log(f"{'В каталог' if on else 'Из каталога'}: {name}", journal=False)
        await self.changed("projects")
        return res

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
                "editable": len(text) <= NOTE_LIMIT and Path(rel).suffix.lower() in (".md", ".txt"),
                "tags": note_tags(text), "backlinks": self.notes.backlinks(rel)}

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

    # ---------- менеджер заметок ----------
    def act_files(self) -> dict:
        return self.notes.index()

    async def act_create_note(self, path: str, template: str | None = None, content: str | None = None) -> dict:
        rel = self.notes.create(path, template=template or None, when=self.now(), content=content)
        await self.log(f"Новая заметка «{self.vault.title_of(rel)}»", journal=False)
        await self.changed("notes")
        return {"path": rel, "version": content_version(self.vault.read(rel))}

    async def act_mkdir(self, path: str) -> dict:
        rel = self.notes.mkdir(path)
        await self.changed("notes")
        return {"path": rel}

    async def act_move_note(self, src: str, dst: str) -> dict:
        """Переименовать / переместить заметку или папку; ссылки [[…]] на неё правятся во всём хранилище."""
        res = self.notes.move(src, dst)
        if res.get("moved"):
            extra = f", ссылки поправлены в {len(res['updated'])} заметках" if res["updated"] else ""
            await self.log(f"«{src}» → «{res['path']}»{extra}", journal=False)
        await self.changed("notes")
        return res

    async def act_trash_note(self, path: str) -> dict:
        res = self.notes.trash(path)
        await self.log(f"В корзину: «{path}»", journal=False)
        await self.changed("notes")
        return res

    def ask_trash(self, path: str) -> PendingAction:
        """Для мозга и голоса: удаление — только после подтверждения владельца."""
        rel = path if self.vault.exists(path) or self.vault.is_dir(path) else self.vault.find_note(path)
        if not rel:
            raise ValueError(f"не нашёл заметку «{path}»")
        return self.ask_confirm("trash", f"Переместить «{rel}» в корзину", {"path": rel})

    # ---------- проекты: создание, статус, страница ----------
    async def act_project_create(self, name: str, description: str = "", repo: str = "", tag: str = "",
                                 status: str = "active") -> dict:
        project = self.projects.create(name, self.now(), description=description, repo=repo, tag=tag, status=status)
        await self.log(f"Новый проект: {project.name}")
        await self.changed("projects")
        await self.changed("notes")
        return project.as_dict()

    async def act_project_update(self, name: str, key: str, value: str) -> dict:
        project = self._project(name)
        updated = self.projects.set_field(project, key, value)
        if key == "status":
            self.projects.log(updated, f"Статус: {STATUSES.get(value, value)}", self.now())
        await self.changed("projects")
        return updated.as_dict()

    def act_project_overview(self, name: str) -> dict:
        project = self._project(name)
        linked = self.notes.backlinks(project.note)
        linked += [n for n in self.notes.outlinks(project.note) if n not in linked]   # «Материалы» проекта
        return self.projects.overview(project, self.tasks.all(), self.notes.index()["files"], linked)

    # ---------- синтез проектов ----------
    def act_synthesis(self) -> dict:
        """Какие заметки относятся к проектам и какие проекты ещё не оформлены (jarvis/synthesis.py)."""
        tasks = [{"path": t.path, "tags": t.tags, "open": t.is_open} for t in self.tasks.all()]
        return synthesize(self.notes.index()["files"], [p.as_dict() for p in self.projects.list()], tasks,
                          projects_dir=self.cfg.projects_dir)

    async def act_synthesis_create(self, name: str, status: str = "idea") -> dict:
        """Оформить кандидата из синтеза проектом: заметка с его тегом и ссылками на материалы."""
        key = name.lower().strip()
        cands = self.act_synthesis()["candidates"]
        c = next((c for c in cands if key in (c["name"].lower(), c["tag"])), None) \
            or next((c for c in cands if key and key in c["name"].lower()), None)
        if not c:
            raise ValueError(f"в синтезе нет кандидата «{name}»")
        return await self.act_project_create(c["name"], synthesis_description(c), tag=c["tag"], status=status)

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
        if it.name == "finance_analytics":
            return self._analytics_reply()
        if it.name == "assets_report":
            return await self._assets_reply()
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
        if it.name == "meetings":
            return self._meetings_reply(a.get("period", "all"))
        if it.name == "map":
            await self.hub.emit("open_map", a, log_it=False)
            if a.get("route"):
                text = f"Строю маршрут до «{a['route']}», {t}."
            elif a.get("query"):
                text = f"Ищу на карте «{a['query']}»."
            elif a.get("nearby"):
                text = "Смотрю, что рядом."
            elif a.get("locate"):
                text = "Определяю, где вы."
            else:
                text = f"Открываю карту, {t}."
            return Reply(text, kind="ok", data={"open_map": a})
        if it.name == "files":
            await self.hub.emit("open_files", {}, log_it=False)
            return Reply(f"Открываю хранилище, {t}.", kind="ok", data={"open_files": True})
        if it.name == "note_delete":
            item = self.ask_trash(a["query"])
            return Reply(f"{item.title}? Подтвердите.", kind="warn", confirm=item.as_dict())
        if it.name == "project_create":
            res = await self.act_project_create(a["name"])
            await self.hub.emit("open_project", {"name": res["name"]}, log_it=False)
            return Reply(f"Проект «{res['name']}» создан, {t}. Заметка — {res['note']}.", kind="ok", data=res)
        if it.name == "project_open":
            project = self._project(a["project"])
            await self.hub.emit("open_project", {"name": project.name}, log_it=False)
            return Reply(f"Открываю проект {project.name}, {t}.", kind="ok", data={"open_project": project.name})
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
        if it.name == "synthesis":
            await self.hub.emit("open_synthesis", {}, log_it=False)
            return self._synthesis_reply()
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

    def _meetings_reply(self, period: str) -> Reply:
        ref = self.today()
        day = {"сегодня": ref.isoformat(), "завтра": (ref + timedelta(days=1)).isoformat()}.get(period)
        week = (ref + timedelta(days=7)).isoformat()
        up = self.act_meetings()["upcoming"]
        if day:
            up = [m for m in up if m["due"] == day]
        elif period == "неделю":
            up = [m for m in up if m["due"] and m["due"] <= week]
        label = {"сегодня": "на сегодня", "завтра": "на завтра", "неделю": "на неделю"}.get(period, "")
        if not up:
            return Reply(f"Встреч {label or 'впереди'} нет, {self.title}.", data=up)
        parts = [f"{m['title']}{' в ' + m['time'] if m['time'] else ''}"
                 f"{'' if day or not m['due'] else ', ' + ru.human_date(date.fromisoformat(m['due']), ref)}"
                 for m in up[:6]]
        n = len(up)
        word = ru.plural(n, "встреча", "встречи", "встреч")
        return Reply(f"{n} {word}{' ' + label if label else ''}: " + "; ".join(parts) + ".", data=up)

    def _analytics_reply(self) -> Reply:
        a = self.act_finance_analytics()
        lines = a["insights"] or ["Данных пока мало: нужно хотя бы несколько операций."]
        cur = self.cfg.currency
        rec = [r for r in a["recurring"] if not r["paid"]][:3]
        if rec:
            lines.append("Ожидаются: " + ", ".join(f"{r['note']} — {ru.money(r['amount'], cur)}" for r in rec) + ".")
        return Reply(" ".join(lines), data=a)

    async def _assets_reply(self) -> Reply:
        r = await self.act_assets()
        cur = self.cfg.currency
        if not r["items"] and not r["debts"]:
            return Reply(f"Активы пока не заведены, {self.title}. Откройте «Финансы → Активы» — я создам таблицу "
                         f"в {self.portfolio.path}.", data=r)
        text = (f"Активы — {ru.money(r['total'], cur)}, долги — {ru.money(r['debt'], cur)}, "
                f"чистый капитал — {ru.money(r['net_worth'], cur)}.")
        if r["pnl_pct"] is not None and r["cost"]:
            text += f" К цене покупки: {'+' if r['pnl'] >= 0 else '−'}{ru.money(abs(r['pnl']), cur)} ({r['pnl_pct']}%)."
        return Reply(text, data=r)

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

    def _synthesis_reply(self) -> Reply:
        syn = self.act_synthesis()
        cands = syn["candidates"]
        linked = sum(len(p["notes"]) for p in syn["projects"])
        head = f"Проектов: {len(syn['projects'])}, заметок при них: {linked}."
        if not cands:
            return Reply(f"{head} Новых проектов в хранилище не вижу, {self.title}.", data=syn)
        names = ", ".join(
            f"{c['name']} ({len(c['notes'])} {ru.plural(len(c['notes']), 'заметка', 'заметки', 'заметок')})"
            for c in cands[:4])
        return Reply(f"{head} Похоже на проекты: {names}. Подсветил их в хранилище.", kind="ok", data=syn)

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

    async def act_system(self) -> dict:
        """Приложение «Настройки и диагностика»: показатели сервера, состояние служб, версия, настройки."""
        try:
            version = await self.updater.status()
        except UpdateError as e:
            version = {"git": False, "reason": str(e)}
        services = [
            {"id": "brain", "label": "Мозг", "ok": self.brain.available,
             "text": f"{self.brain.title or 'Claude'} · {self.brain.model}" if self.brain.available
             else "не подключён — работают только команды"},
            {"id": "voice", "label": "Голос", "ok": True, "text": f"{self.cfg.tts_engine} · {self.cfg.tts_voice}"},
            {"id": "telegram", "label": "Telegram", "ok": self.cfg.telegram_enabled,
             "text": "бот на связи" if self.cfg.telegram_enabled else "не настроен — токен бота и ваш ID"},
            {"id": "sync", "label": "Хранилище", "ok": not (self.git and self.git.last_error),
             "text": (f"GitHub · {self.git.remote.split('github.com/')[-1].removesuffix('.git')}"
                      + (f" · ошибка: {self.git.last_error}" if self.git.last_error else "")) if self.git
             else f"папка {self.vault.root}"},
            {"id": "github", "label": "GitHub", "ok": bool(self.cfg.github_token),
             "text": "токен задан" if self.cfg.github_token else "нет токена — проекты без статуса GitHub"},
        ]
        return {"diag": self.diagnostics(), "services": services, "version": version,
                "settings": self.settings.public(), "atom_uptime_min": round((time.time() - self.started) / 60),
                "can_restart": self.restart_hook is not None}

    async def act_ssh_check(self, sid: str) -> dict:
        """Проверить, отвечает ли SSH-сервер (без входа: соединение и приветствие сервера)."""
        s = self.settings.ssh_get(sid)
        t0 = time.monotonic()
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(s["host"], int(s["port"])), 6)
            try:
                banner = (await asyncio.wait_for(reader.readline(), 4)).decode("latin-1", "replace").strip()
            finally:
                writer.close()
        except (OSError, asyncio.TimeoutError) as e:
            return {"ok": False, "error": str(e) or "нет ответа", "id": sid}
        return {"ok": banner.startswith("SSH-"), "banner": banner[:120], "ms": round((time.monotonic() - t0) * 1000),
                "id": sid, **({} if banner.startswith("SSH-") else {"error": "порт открыт, но это не SSH"})}


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
• «Открой хранилище» — заметки и проекты: папки, теги, шаблоны, корзина.
• «Создай проект Кофейня» · «открой проект IPAStore» — страница проекта: задачи, прогресс, заметки.
• «Синтез проектов» — найду в хранилище заметки проектов и то, что похоже на новый проект, и подсвечу.
• «Статус проектов» · «поручи IPAStore: добавить экспорт в CSV» (задача для @claude) ·
  «поручи локально Atom: …» (Claude Code на этом компьютере) · «задеплой IPAStore».
• Протоколы: Утро, Фокус, Итоги дня, Неделя, Диагностика, Чистый лист, Вечеринка, Тишина и ваши из Obsidian.
• С ключом Claude — свободный разговор, поиск в интернете и анализ фото (чеков, документов)."""
