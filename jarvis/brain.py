"""Мозг Jarvis — Claude (Anthropic API) с инструментами для памяти, задач, финансов и проектов.
Вместо Claude можно подключить GigaChat или YandexGPT (`JARVIS_LLM`, jarvis/llm.py) — разговор, личность
и инструменты те же, меняется только формат запросов.

Как устроен разговор:
- история только дописывается (append-only): так работает кэш промпта и сохраняются блоки
  рассуждений модели; системный промпт (личность + профиль + память) собирается один раз на разговор;
- текущее время и служебные заметки идут в начало каждого сообщения пользователя, а не в system;
- после долгой паузы или длинного разговора история «сжимается»: новый разговор начинается
  с краткого резюме предыдущего (а сама переписка всё равно сохранена в Obsidian);
- включён серверный фолбэк (`fallbacks: "default"`): если основная модель откажется отвечать,
  API сам повторит запрос на рекомендованной резервной модели.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import TYPE_CHECKING, Any

from . import ru
from .core import Reply
from .github import GitHubError
from .vault import VaultError

if TYPE_CHECKING:
    from .core import Jarvis

log = logging.getLogger("jarvis.brain")
FALLBACK_BETA = "server-side-fallback-2026-07-01"
IDLE_RESET_SECONDS = 30 * 60
MAX_TOOL_ROUNDS = 10
MAX_TOOL_RESULT = 12000


def _obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


S = {"type": "string"}
TOOLS: list[dict] = [
    {"name": "tasks_list", "description": "Список открытых задач владельца из Obsidian.",
     "input_schema": _obj({"view": {"type": "string", "enum": ["today", "overdue", "week", "tomorrow", "nodate", "all"],
                                    "description": "today — на сегодня и просроченные; week — со сроком в 7 дней"},
                           "project": {**S, "description": "имя проекта для фильтра"}}, ["view"])},
    {"name": "task_add", "description": "Добавить задачу (в формате Obsidian Tasks).",
     "input_schema": _obj({"text": S, "due": {**S, "description": "срок YYYY-MM-DD"},
                           "priority": {"type": "string", "enum": ["highest", "high", "medium", "low", "lowest"]},
                           "project": {**S, "description": "проект, к которому относится задача"}}, ["text"])},
    {"name": "task_complete", "description": "Отметить задачу выполненной — по id из tasks_list или по тексту.",
     "input_schema": _obj({"task_id": S, "query": {**S, "description": "часть текста задачи"}})},
    {"name": "money_add", "description": "Записать расход (отрицательная сумма) или доход (положительная) в рублях.",
     "input_schema": _obj({"amount_rub": {"type": "number"}, "category": S, "note": S,
                           "date": {**S, "description": "YYYY-MM-DD, по умолчанию сегодня"}},
                          ["amount_rub", "category", "note"])},
    {"name": "finance_report", "description": "Сводка финансов за месяц: доходы, расходы, категории, бюджет, прогноз.",
     "input_schema": _obj({"month": {**S, "description": "YYYY-MM, по умолчанию текущий"}})},
    {"name": "memory_remember", "description": "Сохранить устойчивый факт о владельце в долговременную память.",
     "input_schema": _obj({"fact": S}, ["fact"])},
    {"name": "memory_search", "description": "Поиск по всем заметкам Obsidian (память, проекты, журнал, разговоры).",
     "input_schema": _obj({"query": S}, ["query"])},
    {"name": "note_read", "description": "Прочитать заметку Obsidian по пути относительно хранилища.",
     "input_schema": _obj({"path": S}, ["path"])},
    {"name": "note_append", "description": "Дописать текст в конец заметки (создаст её, если нет). Только .md.",
     "input_schema": _obj({"path": S, "text": S}, ["path", "text"])},
    {"name": "journal_note", "description": "Короткая запись в сегодняшнюю ежедневную заметку.",
     "input_schema": _obj({"text": S}, ["text"])},
    {"name": "reminder_add", "description": "Напоминание через N минут (голосом на дашборде и в Telegram).",
     "input_schema": _obj({"text": S, "minutes": {"type": "integer", "minimum": 1}}, ["text", "minutes"])},
    {"name": "projects_status", "description": "Живой статус проектов: CI, PR, задачи GitHub, health, метрики.",
     "input_schema": _obj({"project": S})},
    {"name": "project_delegate",
     "description": "Поручить работу над кодом проекта: mode=github — задача для @claude в репозитории "
                    "(он откроет PR); mode=local — Claude Code на этом компьютере. Требует подтверждения владельца.",
     "input_schema": _obj({"project": S, "task": {**S, "description": "подробное техзадание"},
                           "mode": {"type": "string", "enum": ["github", "local"]}}, ["project", "task", "mode"])},
    {"name": "project_deploy", "description": "Запустить деплой проекта (GitHub Actions). Требует подтверждения.",
     "input_schema": _obj({"project": S}, ["project"])},
    {"name": "run_protocol", "description": "Запустить протокол (утро, фокус, итоги, неделя, диагностика, "
                                            "чистый лист, вечеринка или свой из Obsidian).",
     "input_schema": _obj({"name": S}, ["name"])},
    {"name": "system_diagnostics", "description": "Состояние сервера: CPU, память, диск, сеть, батарея.",
     "input_schema": _obj({})},
    {"name": "weather_and_rates", "description": "Текущая погода в городе владельца и курсы ЦБ.",
     "input_schema": _obj({})},
]

PERSONA = """Ты — J.A.R.V.I.S., личный ИИ-ассистент владельца. Обращайся к нему «{title}»{name}.
Манера: безупречно вежливый британский дворецкий с суховатым юмором — спокойный, точный, немногословный, \
заботливый без подобострастия. Иногда уместная ирония, но дело — прежде всего.
Ответы часто звучат голосом: обычно 1–3 коротких предложения, без markdown, таблиц, списков и эмодзи, \
если владелец сам не попросил подробностей. Отвечай на языке владельца (обычно русский).

Твоя долговременная память — хранилище Obsidian (markdown):
- {jarvis_dir}/Memory.md — факты о владельце, {jarvis_dir}/Profile.md — его профиль;
- {tasks_file} — входящие задачи (формат Obsidian Tasks, задачи бывают и в других заметках);
- {projects_dir}/ — заметки проектов; {finance_dir}/ — финансы по месяцам; {journal_dir}/ — ежедневные заметки.
Правила:
- Узнал устойчивое о владельце (предпочтения, планы, решения, важных людей) — сохрани через memory_remember, \
не спрашивая разрешения. Вопросы о прошлом и о заметках — сначала memory_search.
- Задачи, деньги, статусы проектов бери только из инструментов, ничего не выдумывай.
- Деньги — в рублях; расход — отрицательная сумма. Категории: Еда, Кафе, Транспорт, Подписки, Связь, Дом, \
Здоровье, Спорт, Развлечения, Одежда, Образование, Бизнес, Подарки, Доход, Прочее.
- Работа над кодом проектов — через project_delegate: составь ясное техзадание. Внешние действия \
(задача для @claude, Claude Code, деплой) ждут подтверждения владельца — так и скажи.
- Каждое сообщение владельца начинается со служебной строки в квадратных скобках: дата, время, источник.

Профиль владельца:
{profile}

Что ты помнишь о владельце:
{facts}

Проекты: {projects}"""


class Brain:
    def __init__(self, jarvis: "Jarvis", client: Any = None):
        self.j = jarvis
        self._client = client
        self.messages: list[dict] = []
        self.system: str | None = None
        self.turns = 0
        self.last_activity = 0.0
        self.notes: list[str] = []
        self.lock = asyncio.Lock()
        self.usage = {"input": 0, "output": 0, "cache_read": 0}
        self._chat: Any = None   # GigaChat / YandexGPT (jarvis/llm.py), если мозг — не Claude

    @property
    def backend(self) -> str:
        """claude | gigachat | yandex; пусто — мозга нет, только команды."""
        return "claude" if self._client is not None else self.j.cfg.llm_backend

    @property
    def available(self) -> bool:
        return bool(self.backend)

    @property
    def title(self) -> str:
        return {"claude": "Claude", "gigachat": "GigaChat", "yandex": "YandexGPT"}.get(self.backend, "")

    @property
    def model(self) -> str | None:
        cfg = self.j.cfg
        return {"claude": cfg.model, "gigachat": cfg.gigachat_model, "yandex": cfg.yandex_model}.get(self.backend)

    def chat(self):
        if self._chat is None:
            from .llm import make_chat
            self._chat = make_chat(self.j.cfg, self.backend)
        return self._chat

    async def close(self) -> None:
        if self._chat is not None:
            await self._chat.close()

    def client(self):
        if self._client is None:
            import anthropic  # импорт здесь: без ключа API модуль не нужен
            self._client = anthropic.AsyncAnthropic()
        return self._client

    def note(self, text: str) -> None:
        """Служебная заметка, которую модель увидит в начале следующего сообщения."""
        self.notes.append(text)

    def tools(self) -> list[dict]:
        tools = list(TOOLS)
        if self.j.cfg.web_search and self.backend == "claude":
            tools.append({"type": "web_search_20260209", "name": "web_search", "max_uses": 3})
        return tools

    def build_system(self) -> str:
        cfg = self.j.cfg
        facts = self.j.memory.facts()[-60:]
        projects = self.j.projects.list()
        return PERSONA.format(
            title=cfg.user_title, name=f" (имя — {cfg.user_name})" if cfg.user_name else "",
            jarvis_dir=cfg.jarvis_dir, tasks_file=cfg.tasks_file, projects_dir=cfg.projects_dir,
            finance_dir=cfg.finance_dir, journal_dir=cfg.journal_dir,
            profile=self.j.memory.profile()[:4000] or "(пусто)",
            facts="\n".join(f"- {f['text']}" for f in facts) or "(пока ничего)",
            projects=", ".join(f"{p.name}" + (f" (repo {p.repo})" if p.repo else "") for p in projects) or "нет",
        )

    def _summary(self) -> str:
        """Резюме прошлого разговора для «простого сжатия» — без лишнего запроса к модели."""
        pairs = []
        for m in self.messages:
            if m["role"] != "user" or not isinstance(m["content"], str):
                continue
            pairs.append(m["content"].split("\n", 1)[-1][:200])
        if not pairs:
            return ""
        return "Ранее в разговоре владелец говорил: " + " | ".join(pairs[-8:])

    def reset(self, keep_summary: bool = True) -> None:
        summary = self._summary() if keep_summary else ""
        self.messages, self.system, self.turns = [], None, 0
        if summary:
            self.notes.insert(0, summary)

    def _header(self, source: str) -> str:
        n = self.j.now()
        head = f"[{n:%Y-%m-%d %H:%M}, {ru.WEEKDAYS[n.weekday()]}; источник: {source}]"
        if self.notes:
            head += "\n[Служебно: " + " ".join(self.notes) + "]"
            self.notes = []
        return head

    async def ask(self, text: str, source: str = "dashboard") -> Reply:
        async with self.lock:
            if self.messages and (time.time() - self.last_activity > IDLE_RESET_SECONDS
                                  or self.turns >= self.j.cfg.max_history_turns):
                self.reset()
            if self.system is None:
                self.system = self.build_system()
            self.last_activity = time.time()
            self.messages.append({"role": "user", "content": f"{self._header(source)}\n{text}"})
            self.turns += 1
            return await self._run(self.messages)

    async def analyze_image(self, data: bytes, mime: str, hint: str = "") -> Reply:
        """Фото чека/документа → Claude смотрит и сам вызывает инструменты (расходы, задачи)."""
        if self.backend != "claude":
            return Reply(f"Разбирать фото пока умеет только Claude, {self.j.title}. Опишите словами — запишу.",
                         kind="warn", source="system")
        async with self.lock:
            system = self.system or self.build_system()
            task = hint.strip() or ("Посмотри на изображение. Если это чек или квитанция — запиши расходы через "
                                    "money_add (одной суммой или по позициям, если категории разные). Если это "
                                    "документ или скриншот с делами — предложи задачи и добавь важные. "
                                    "Коротко доложи, что сделал.")
            msgs = [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime,
                                             "data": base64.standard_b64encode(data).decode()}},
                {"type": "text", "text": f"{self._header('камера')}\n{task}"},
            ]}]
            return await self._run(msgs, system=system)

    async def _create(self, messages: list[dict], system: str):
        cfg = self.j.cfg
        return await self.client().beta.messages.create(
            model=cfg.model,
            max_tokens=16000,
            system=system,
            tools=self.tools(),
            messages=messages,
            output_config={"effort": cfg.effort},
            cache_control={"type": "ephemeral"},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )

    async def _run(self, messages: list[dict], system: str | None = None) -> Reply:
        system = system or self.system or self.build_system()
        if self.backend != "claude":
            return await self._run_chat(messages, system)
        import anthropic

        confirm = None
        start_len = len(messages)
        for _ in range(MAX_TOOL_ROUNDS):
            try:
                resp = await self._create(messages, system)
            except anthropic.AuthenticationError:
                del messages[start_len - 1:]
                return Reply("Ключ Claude API недействителен, " + self.j.title + ". Проверьте ANTHROPIC_API_KEY.",
                             kind="error", source="system")
            except anthropic.RateLimitError:
                del messages[start_len - 1:]
                return Reply("Claude просит передышку — лимит запросов. Попробуйте через минуту.", kind="warn",
                             source="system")
            except anthropic.APIConnectionError:
                del messages[start_len - 1:]
                return Reply("Нет связи с Claude. Команды без интернета по-прежнему работают.", kind="warn",
                             source="system")
            except anthropic.APIStatusError as e:
                del messages[start_len - 1:]
                log.error("Claude API: %s", e)
                return Reply(f"Claude ответил ошибкой {e.status_code}. Подробности — в логе.", kind="error",
                             source="system")
            self._count(resp)
            if resp.stop_reason == "refusal":
                # история не должна содержать отклонённый ход: убираем последнее сообщение пользователя
                del messages[start_len - 1:]
                return Reply(f"Боюсь, с этим я помочь не могу, {self.j.title}.", kind="warn", source="claude")
            messages.append({"role": "assistant", "content": resp.content})
            if resp.stop_reason == "pause_turn":
                continue
            calls = [b for b in resp.content if getattr(b, "type", None) == "tool_use"]
            if resp.stop_reason != "tool_use" or not calls:
                text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
                if resp.stop_reason == "max_tokens" and not text:
                    text = "Ответ получился слишком длинным и оборвался."
                return Reply(text or "Готово, " + self.j.title + ".", source="claude", confirm=confirm)
            results = []
            for call in calls:
                content, is_error, pending = await self._run_tool(call.name, call.input or {})
                if pending:
                    confirm = pending
                results.append({"type": "tool_result", "tool_use_id": call.id, "content": content,
                                **({"is_error": True} if is_error else {})})
            messages.append({"role": "user", "content": results})
        return Reply("Слишком много шагов для одной просьбы — остановился. Уточните задачу.", kind="warn",
                     source="claude", confirm=confirm)

    async def _run_chat(self, messages: list[dict], system: str) -> Reply:
        """Тот же цикл «ответ → инструменты → ответ», но через GigaChat / YandexGPT (jarvis/llm.py).
        История — в формате этой модели (модель не меняется посреди работы Jarvis)."""
        from .llm import LLMAuthError, LLMError

        chat = self.chat()
        confirm = None
        start_len = len(messages)
        for _ in range(MAX_TOOL_ROUNDS):
            try:
                turn = await chat.complete(system, messages, TOOLS)
            except LLMAuthError as e:
                del messages[start_len - 1:]
                log.error("%s: ключ не принят: %s", chat.title, e)
                return Reply(f"{chat.title} не принял ключ, {self.j.title}: {e}. Проверьте настройки в .env.",
                             kind="error", source="system")
            except LLMError as e:
                del messages[start_len - 1:]
                log.error("%s: %s", chat.title, e)
                return Reply(f"{chat.title} сейчас недоступен: {e}. Команды без ИИ по-прежнему работают.",
                             kind="warn", source="system")
            self.usage["input"] += turn.usage[0]
            self.usage["output"] += turn.usage[1]
            if turn.refused:
                del messages[start_len - 1:]   # как и с Claude: отклонённый ход не остаётся в истории
                return Reply(f"Боюсь, с этим я помочь не могу, {self.j.title}.", kind="warn", source=chat.name)
            messages.append(turn.message)
            if not turn.calls:
                return Reply(turn.text.strip() or f"Готово, {self.j.title}.", source=chat.name, confirm=confirm)
            for call_id, name, args in turn.calls:
                content, is_error, pending = await self._run_tool(name, args)
                if pending:
                    confirm = pending
                messages.append(chat.tool_message(call_id, name, content, is_error))
        return Reply("Слишком много шагов для одной просьбы — остановился. Уточните задачу.", kind="warn",
                     source=chat.name, confirm=confirm)

    def _count(self, resp) -> None:
        u = getattr(resp, "usage", None)
        if u:
            self.usage["input"] += getattr(u, "input_tokens", 0) or 0
            self.usage["output"] += getattr(u, "output_tokens", 0) or 0
            self.usage["cache_read"] += getattr(u, "cache_read_input_tokens", 0) or 0

    async def _run_tool(self, name: str, args: dict) -> tuple[str, bool, dict | None]:
        j = self.j
        await j.hub.emit("tool", {"name": name, "args": args}, log_it=False)
        pending = None
        try:
            if not isinstance(args, dict):
                raise ValueError("аргументы должны быть объектом")
            if name == "tasks_list":
                res: Any = j.act_list_tasks(str(args.get("view") or "today"), args.get("project") or None)
            elif name == "task_add":
                res = await j.act_add_task(str(args["text"]), args.get("due") or None, args.get("priority") or None,
                                           args.get("project") or None)
            elif name == "task_complete":
                res = await j.act_complete_task(args.get("task_id") or None, args.get("query") or None)
            elif name == "money_add":
                amount = int(round(float(args["amount_rub"]) * 100))
                res = await j.act_money(amount, str(args.get("category") or "Прочее"), str(args.get("note") or ""),
                                        args.get("date") or None)
            elif name == "finance_report":
                res = j.act_finance_report(args.get("month") or None)
            elif name == "memory_remember":
                res = await j.act_remember(str(args["fact"]))
            elif name == "memory_search":
                res = j.act_search(str(args["query"]), 8)
            elif name == "note_read":
                text = j.vault.read(str(args["path"]))
                res = {"path": args["path"], "content": text[:MAX_TOOL_RESULT],
                       "truncated": len(text) > MAX_TOOL_RESULT}
            elif name == "note_append":
                path = str(args["path"])
                if not path.endswith(".md"):
                    raise ValueError("дописывать можно только .md заметки")
                rel = j.vault.append(path, str(args["text"]))
                await j.changed("memory")
                res = {"ok": True, "path": rel}
            elif name == "journal_note":
                res = await j.act_note(str(args["text"]))
            elif name == "reminder_add":
                res = await j.act_reminder(str(args["text"]), int(args["minutes"]) * 60)
            elif name == "projects_status":
                res = await j.act_project_status(args.get("project") or None)
            elif name == "project_delegate":
                item = j.act_delegate(str(args["project"]), str(args["task"]), str(args.get("mode") or "github"))
                pending = item.as_dict()
                res = {"status": "awaiting_confirmation", "action_id": item.id, "title": item.title,
                       "note": "Скажи владельцу, что действие ждёт подтверждения (кнопка или «подтверждаю»)."}
            elif name == "project_deploy":
                item = j.act_deploy(str(args["project"]))
                pending = item.as_dict()
                res = {"status": "awaiting_confirmation", "action_id": item.id, "title": item.title}
            elif name == "run_protocol":
                reply = await j.protocols.run(str(args["name"]), depth=1)
                if reply.confirm:
                    pending = reply.confirm
                res = {"result": reply.text}
            elif name == "system_diagnostics":
                res = j.diagnostics()
            elif name == "weather_and_rates":
                res = {"weather": await j.briefing.weather(), "rates": await j.briefing.rates()}
            else:
                return f"неизвестный инструмент {name}", True, None
        except KeyError as e:
            return f"не хватает параметра {e}", True, None
        except (ValueError, VaultError, FileNotFoundError, GitHubError, OSError) as e:
            return f"ошибка: {e}", True, None
        out = json.dumps(res, ensure_ascii=False, default=str)
        if len(out) > MAX_TOOL_RESULT:
            out = out[:MAX_TOOL_RESULT] + "…(обрезано)"
        return out, False, pending
