"""Сценарии команд без Claude: задачи, траты, память, протоколы, подтверждения."""
import asyncio
from datetime import date

from jarvis.intents import parse

from .conftest import make_jarvis

REF = date(2026, 11, 9)
P = ["IPAStore", "Jarvis"]


def test_intents_cover_common_phrases():
    cases = {
        "Джарвис, добавь задачу купить молоко завтра": ("task_add", {"text": "купить молоко", "due": "2026-11-10"}),
        "добавь задачу срочно написать оферту для IPAStore в пятницу":
            ("task_add", {"text": "написать оферту", "priority": "high", "project": "IPAStore", "due": "2026-11-13"}),
        # прилагательное перед «задачу»: текст из него или приоритет
        "Создай тестовую задачу": ("task_add", {"text": "тестовая задача", "due": None}),
        "создай тестовую задачу на завтра по IPAStore":
            ("task_add", {"text": "тестовая задача", "due": "2026-11-10", "project": "IPAStore"}),
        "добавь срочную задачу позвонить маме": ("task_add", {"text": "позвонить маме", "priority": "high"}),
        "добавь мне ещё одну задачу полить цветы": ("task_add", {"text": "полить цветы"}),
        "создай новую задачу проверить сервер": ("task_add", {"text": "проверить сервер"}),
        "добавь задачу": ("task_add", {"text": ""}),     # Jarvis переспросит, что записать
        "потратил 450 на кофе": ("expense", {"amount": -45000, "category": "Кафе", "note": "кофе"}),
        "купил кроссовки за 7990р": ("expense", {"amount": -799000, "note": "кроссовки"}),
        "получил 50 000 зарплата": ("income", {"amount": 5000000, "category": "Доход"}),
        "напомни через 20 минут позвонить маме": ("reminder", {"text": "позвонить маме", "seconds": 1200}),
        "доброе утро": ("protocol", {"name": "утро"}),
        "протокол «Старт работы»": ("protocol", {"name": "старт работы"}),
        "поручи IPAStore: экспорт статистики в CSV":
            ("delegate", {"project": "IPAStore", "task": "экспорт статистики в CSV", "mode": "github"}),
        "поручи локально Jarvis починить тесты": ("delegate", {"project": "Jarvis", "mode": "local"}),
        "задеплой ipastore": ("deploy", {"project": "IPAStore"}),
        "статус ipastore": ("project_status", {"project": "IPAStore"}),
        "как дела у сервера? диагностика": ("protocol", {"name": "диагностика"}),
        "задачи на завтра": ("tasks_list", {"view": "tomorrow"}),
        "запомни что я пью эспрессо": ("remember", {"fact": "я пью эспрессо"}),
        "подтверждаю": ("confirm", {}),
    }
    for text, (name, args) in cases.items():
        it = parse(text, REF, P)
        assert it and it.name == name, (text, it)
        for k, v in args.items():
            assert it.args.get(k) == v, (text, k, it.args)
    assert parse("расскажи анекдот", REF, P) is None
    assert parse("как дела", REF, P) is None


def test_command_flow_writes_obsidian(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        r = await j.handle("добавь задачу проверить оплату Stars для IPAStore сегодня, срочно")
        assert r.kind == "ok" and "добавлена на сегодня" in r.text
        task = r.data
        assert task["tags"] == ["ipastore"] and task["priority"] == 4
        assert "#ipastore ⏫" in j.vault.read("Tasks/Inbox.md")

        r = await j.handle("задачи на сегодня")
        assert "проверить оплату Stars" in r.text

        r = await j.handle("минус 28000 продукты")
        assert "Еда" in r.text and "93%" in r.text and r.kind == "warn"
        assert any("Бюджет «Еда»" in e["data"]["text"] for e in j.hub.events if e["type"] == "alert")

        r = await j.handle("выполнил проверить оплату")
        assert r.kind == "ok" and "✅" in j.vault.read("Tasks/Inbox.md")

        await j.handle("запомни, что IPAStore — главный проект")
        r = await j.handle("что ты знаешь обо мне")
        assert "главный проект" in r.text

        r = await j.handle("напомни через 10 минут проверить почту")
        assert j.reminders.upcoming()[0]["text"] == "проверить почту"

        r = await j.handle("расскажи анекдот")
        assert r.kind == "warn" and "ANTHROPIC_API_KEY" in r.text

        convo = j.vault.read(f"Jarvis/Conversations/{j.today().isoformat()}.md")
        assert "минус 28000 продукты" in convo and "**Jarvis:**" in convo
        await j.close()
    asyncio.run(run())


def test_protocols(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        await j.handle("добавь задачу созвон сегодня")
        r = await j.handle("доброе утро")
        assert r.source == "protocol"
        assert "пасмурно" in r.text and "созвон" in r.text and "доллар 81,50" in r.text

        r = await j.handle("протокол фокус")
        assert j.focus_until and "фокуса на 25 минут" in r.text

        r = await j.handle("протокол итоги")
        assert "## Итоги дня" in j.vault.read(j.memory.journal_path(j.now()))

        r = await j.handle("протокол неделя")
        assert r.data["path"].startswith("Journal/Week-") and j.vault.exists(r.data["path"])

        r = await j.handle("протокол Старт работы")  # свой протокол из Jarvis/Protocols.md
        assert "Старт работы" in r.text and "фокус" in r.text.lower()

        r = await j.handle("протокол диагностика")
        assert "Процессор" in r.text and "Мозг Claude не подключён" in r.text

        r = await j.handle("тишина")
        assert j.voice.muted and r.as_dict()["speech"] == ""
        await j.handle("протокол голос")
        assert not j.voice.muted

        r = await j.handle("протокол несуществующий")
        assert r.kind == "warn"
        await j.close()
    asyncio.run(run())


def test_external_actions_need_confirmation(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        r = await j.handle("поручи IPAStore: экспорт статистики в CSV")
        assert r.confirm and r.confirm["kind"] == "delegate_github" and j.pending
        r = await j.handle("отмена")
        assert r.text == "Отменено." and not j.pending

        r = await j.handle("поручи локально Jarvis: починить тесты")
        assert r.kind == "error" and not r.confirm

        r = await j.handle("забудь эспрессо")
        assert r.confirm and r.confirm["kind"] == "forget"
        r = await j.handle("подтверждаю")
        assert "Таких фактов" in r.text
        await j.close()
    asyncio.run(run())
