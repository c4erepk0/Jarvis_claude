"""Хранилище Obsidian, задачи, финансы, память, русские даты и суммы."""
from datetime import date, datetime, timedelta

import pytest

from jarvis import ru
from jarvis.finance import Ledger, guess_category
from jarvis.memory import Memory
from jarvis.tasks import TaskBook, parse_line
from jarvis.vault import Vault, VaultError, parse_frontmatter

REF = date(2026, 11, 9)  # понедельник


def test_vault_paths_are_confined(tmp_path):
    v = Vault(tmp_path / "v")
    for bad in ["../x.md", "/etc/passwd", "a/../../x.md", ".obsidian/app.json", ""]:
        with pytest.raises(VaultError):
            v.resolve(bad, for_write=True)
    with pytest.raises(VaultError):
        v.write("script.sh", "rm -rf /")
    assert v.write("Папка/Заметка.md", "привет") == "Папка/Заметка.md"
    assert v.read("Папка/Заметка.md") == "привет"
    assert not list((tmp_path / "v" / "Папка").glob(".jarvis-*")), "временные файлы должны убираться"


def test_append_to_section_keeps_order(tmp_path):
    v = Vault(tmp_path)
    v.write("n.md", "# Заголовок\n\n## Задачи\n- a\n\n## Журнал\n- старое\n")
    v.append_to_section("n.md", "Задачи", "- b")
    v.append_to_section("n.md", "Новый раздел", "- c")
    text = v.read("n.md")
    assert text.index("- a") < text.index("- b") < text.index("## Журнал")
    assert text.rstrip().endswith("## Новый раздел\n- c")


def test_frontmatter_and_search_and_graph(tmp_path):
    v = Vault(tmp_path)
    v.write("Projects/IPAStore.md", "---\ntype: project\nrepo: c4erepk0/IPAStore\ntags: [a, b]\nhealth:\n---\n"
                                    "Магазин приложений. Сертификаты Apple. [[Jarvis]]")
    v.write("Projects/Jarvis.md", "# Jarvis\nАссистент с голосом.")
    meta, body = parse_frontmatter(v.read("Projects/IPAStore.md"))
    assert meta["repo"] == "c4erepk0/IPAStore" and meta["tags"] == ["a", "b"] and meta["health"] == []
    assert body.startswith("Магазин")
    hits = v.search("сертификат")
    assert hits and hits[0].path == "Projects/IPAStore.md"
    g = v.graph()
    assert {"source": "Projects/IPAStore.md", "target": "Projects/Jarvis.md"} in g["links"]
    v.diff()
    v.write("Projects/Jarvis.md", "изменено")
    assert v.diff() == ["Projects/Jarvis.md"]


def test_task_format_roundtrip(tmp_path):
    t = parse_line("Tasks/Inbox.md", 3, "- [ ] Написать оферту #ipastore ⏫ ➕ 2026-11-01 📅 2026-11-10")
    assert t and t.text == "Написать оферту" and t.priority == 4 and t.due == "2026-11-10" and t.tags == ["ipastore"]
    assert parse_line("x.md", 0, "- [x] Готово ✅ 2026-11-09").status == "done"
    assert parse_line("x.md", 0, "просто текст") is None

    v = Vault(tmp_path)
    book = TaskBook(v, "Tasks/Inbox.md")
    a = book.add("купить молоко", REF, due=REF)
    b = book.add("бизнес-модель", REF, tags=["ipastore"], note="Projects/IPAStore.md")
    v.write("Journal/note.md", "```\n- [ ] в коде — не задача\n```\n- [ ] задача из дневника 📅 2026-11-01\n")
    assert [t.text for t in book.view(REF, "today")] == ["задача из дневника", "купить молоко"]
    assert [t.text for t in book.view(REF, "overdue")] == ["задача из дневника"]
    assert [t.text for t in book.view(REF, "all", tag="ipastore")] == ["бизнес-модель"]
    # файл поменяли «на телефоне» — id всё равно находит строку
    v.write("Tasks/Inbox.md", "# Входящие\n\nновая строка сверху\n" + v.read("Tasks/Inbox.md"))
    done = book.complete(a.id, REF)
    assert done.status == "done" and "✅ 2026-11-09" in v.read("Tasks/Inbox.md")
    assert book.summary(REF)["done_today"] == 1
    assert book.find("бизнес")[0].id.startswith("Projects/IPAStore.md") and b.text == "бизнес-модель"


def test_clean_slate_archives_old_done(tmp_path):
    v = Vault(tmp_path)
    v.write("Tasks/Inbox.md", "- [x] старое ✅ 2026-10-01\n- [x] свежее ✅ 2026-11-08\n- [ ] открытое\n")
    book = TaskBook(v, "Tasks/Inbox.md")
    assert book.archive_done(REF) == 1
    assert "старое" in v.read("Tasks/Archive.md") and "старое" not in v.read("Tasks/Inbox.md")


def test_ledger_summary_and_budget(tmp_path):
    v = Vault(tmp_path)
    v.write("Finance/Budget.md", "| Категория | Лимит |\n|---|---:|\n| Еда | 10000 |\n| Кафе | 3 000 |\n")
    led = Ledger(v)
    led.add(-45000, "Кафе", "кофе | с молоком", REF)
    led.add(-850050, "Еда", "продукты", REF)
    led.add(12000000, "Доход", "зарплата", REF - timedelta(days=1))
    entries = led.entries("2026-11")
    assert [e.amount for e in entries] == [-45000, -850050, 12000000]
    assert entries[0].note == "кофе / с молоком", "символ | не должен ломать таблицу"
    s = led.summary("2026-11", REF)
    assert s["expense"] == 895050 and s["income"] == 12000000 and s["budget_total"] == 1300000
    assert s["categories"][0]["category"] == "Еда" and s["categories"][0]["percent"] == 85
    assert "85%" in led.budget_alert("Еда", "2026-11")
    assert led.budget_alert("Кафе", "2026-11") is None
    assert guess_category("такси до дома") == "Транспорт" and guess_category("что-то") == "Прочее"


def test_memory_facts(tmp_path):
    v = Vault(tmp_path)
    m = Memory(v)
    when = datetime(2026, 11, 9, 9, 30)
    m.remember("Пью эспрессо без сахара.", when)
    assert m.remember("пью эспрессо без сахара", when)["duplicate"]
    assert m.facts() == [{"date": "2026-11-09", "text": "Пью эспрессо без сахара"}]
    m.log_event("событие", when)
    assert "- 09:30 событие" in v.read("Journal/2026-11-09.md")
    assert m.forget("эспрессо") == 1 and m.facts() == []


def test_russian_dates_and_amounts():
    assert ru.parse_date("купить молоко завтра", REF) == (date(2026, 11, 10), "купить молоко")
    assert ru.parse_date("отчёт в пятницу", REF)[0] == date(2026, 11, 13)
    assert ru.parse_date("через неделю созвон", REF)[0] == date(2026, 11, 16)
    assert ru.parse_date("оплатить 5 января", REF)[0] == date(2027, 1, 5)
    assert ru.parse_date("до 12.11 сдать", REF)[0] == date(2026, 11, 12)
    assert ru.parse_date("просто текст", REF) == (None, "просто текст")
    assert ru.parse_amount("1 200,50 на кофе")[0] == 120050
    assert ru.parse_amount("1,5к такси")[0] == 150000
    assert ru.parse_amount("2 тыс за обед")[0] == 200000
    assert ru.parse_money_cell("−1 200,5") == -120050
    assert ru.money(-123456) == "−1 234,56 ₽"
    assert ru.plural(21, "задача", "задачи", "задач") == "задача" and ru.plural(12, "a", "b", "c") == "c"
    assert ru.parse_duration("через 20 минут позвонить")[0] == timedelta(minutes=20)
