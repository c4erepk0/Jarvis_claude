"""Мозг на Claude: цикл инструментов, append-only история, фолбэк, отказ, подтверждения — на фейковом клиенте."""
import asyncio
import copy
import json
from types import SimpleNamespace as NS

from jarvis.brain import FALLBACK_BETA, TOOLS

from .conftest import make_jarvis


def text(t):
    return NS(type="text", text=t)


def tool(name, args, tid):
    return NS(type="tool_use", name=name, input=args, id=tid)


def resp(blocks, stop="end_turn"):
    usage = NS(input_tokens=100, output_tokens=20, cache_read_input_tokens=50)
    return NS(content=blocks, stop_reason=stop, usage=usage)


class FakeClient:
    """Повторяет форму `client.beta.messages.create(...)` и запоминает каждый запрос."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []
        self.beta = NS(messages=NS(create=self.create))

    async def create(self, **kw):
        self.calls.append({**kw, "messages": copy.copy(kw["messages"])})
        step = self.script.pop(0)
        return step(kw) if callable(step) else step


def test_tool_loop_and_history(tmp_path):
    async def run():
        client = FakeClient([
            resp([text("Сейчас посмотрю."), tool("task_add", {"text": "позвонить в банк", "due": "2026-11-10"}, "t1"),
                  tool("money_add", {"amount_rub": -350.5, "category": "Кафе", "note": "латте"}, "t2")], "tool_use"),
            resp([text("Записал задачу и расход, сэр.")]),
            resp([tool("memory_search", {"query": "банк"}, "t3")], "tool_use"),
            resp([text("Задача про банк — на завтра.")]),
        ])
        j = make_jarvis(tmp_path, llm=client)
        assert j.brain.available
        r = await j.handle("запиши звонок в банк на завтра и латте за 350,50")
        assert r.source == "claude" and r.text == "Записал задачу и расход, сэр."
        assert "позвонить в банк" in j.vault.read("Tasks/Inbox.md")
        assert "| -350.50 | Кафе | латте |" in j.vault.read(f"Finance/{j.today():%Y-%m}.md")

        first, second = client.calls[0], client.calls[1]
        assert first["model"] == "claude-opus-5-5" and first["fallbacks"] == "default"
        assert FALLBACK_BETA in first["betas"] and first["output_config"] == {"effort": "low"}
        assert first["cache_control"] == {"type": "ephemeral"}
        assert "web_search" in [t["name"] for t in first["tools"]]
        # результаты обоих инструментов — в одном сообщении пользователя
        results = second["messages"][-1]["content"]
        assert [x["tool_use_id"] for x in results] == ["t1", "t2"] and not any(x.get("is_error") for x in results)
        assert json.loads(results[1]["content"])["amount"] == -35050

        r = await j.handle("что там с банком?")
        third = client.calls[2]
        # история только дописывается, системный промпт и инструменты не меняются
        assert third["messages"][:len(second["messages"])] == second["messages"]
        assert third["system"] == first["system"] and third["tools"] == first["tools"]
        last = third["messages"][-1]["content"]
        assert last.startswith("[") and "что там с банком?" in last
        assert r.text == "Задача про банк — на завтра."
        await j.close()
    asyncio.run(run())


def test_prefix_is_append_only(tmp_path):
    async def run():
        client = FakeClient([resp([text("Раз.")]), resp([text("Два.")]), resp([text("Три.")])])
        j = make_jarvis(tmp_path, llm=client, local_first=False)
        for q in ("один", "два", "три"):
            await j.handle(f"скажи {q}")
        a, b, c = (x["messages"] for x in client.calls)
        assert b[:len(a)] == a and c[:len(b)] == b
        await j.close()
    asyncio.run(run())


def test_refusal_is_not_kept_in_history(tmp_path):
    async def run():
        client = FakeClient([resp([], "refusal"), resp([text("Конечно.")])])
        j = make_jarvis(tmp_path, llm=client)
        r = await j.handle("что-то недопустимое")
        assert r.kind == "warn" and "не могу" in r.text
        assert j.brain.messages == []
        await j.handle("обычный вопрос")
        assert len(client.calls[1]["messages"]) == 1
        await j.close()
    asyncio.run(run())


def test_delegate_tool_waits_for_confirmation(tmp_path):
    async def run():
        client = FakeClient([
            resp([tool("project_delegate", {"project": "IPAStore", "task": "Экспорт статистики в CSV",
                                            "mode": "github"}, "d1")], "tool_use"),
            resp([text("Готово к отправке — подтвердите, сэр.")]),
        ])
        j = make_jarvis(tmp_path, llm=client)
        r = await j.handle("сделай в магазине экспорт статистики, пусть Claude займётся")
        assert r.confirm and r.confirm["kind"] == "delegate_github"
        payload = json.loads(client.calls[1]["messages"][-1]["content"][0]["content"])
        assert payload["status"] == "awaiting_confirmation"
        await j.close()
    asyncio.run(run())


def test_bad_tool_input_is_reported_not_crashing(tmp_path):
    async def run():
        client = FakeClient([
            resp([tool("note_read", {"path": "../../etc/passwd"}, "x1"), tool("task_add", {}, "x2")], "tool_use"),
            resp([text("Не получилось.")]),
        ])
        j = make_jarvis(tmp_path, llm=client)
        await j.handle("прочитай системный файл")
        results = client.calls[1]["messages"][-1]["content"]
        assert all(x.get("is_error") for x in results)
        await j.close()
    asyncio.run(run())


def test_tool_schemas_are_valid():
    names = [t["name"] for t in TOOLS]
    assert len(names) == len(set(names))
    for t in TOOLS:
        schema = t["input_schema"]
        assert schema["type"] == "object" and schema["additionalProperties"] is False
        assert set(schema["required"]) <= set(schema["properties"])
