"""Встречи и поручения — поверх обычных задач Obsidian Tasks, чтобы их было видно и в Obsidian, и в Atom:

- [ ] Созвон с поставщиком 🕒 15:00 📍 Zoom #встреча #оператор/иван ➕ 2026-11-18 📅 2026-11-20

Встреча — задача с тегом #встреча (время 🕒 и место 📍 — в тексте), поручение оператору — тег #оператор/<имя>.
Отметить встречу «состоялась» — то же, что выполнить задачу. Порт для iPhone — core/meetings.js.
"""
from __future__ import annotations

import re
from typing import Any

MEET_TAG = "встреча"
OP_TAG = "оператор/"
TIME = re.compile(r"🕒\s*(\d{1,2}:\d{2})")
PLACE = re.compile(r"📍\s*([^🕒📍#]+)")


def meeting_text(title: str, time: str = "", place: str = "") -> str:
    title = re.sub(r"[🕒📍]", "", title).strip()
    if not title:
        raise ValueError("укажите, что за встреча")
    if time and not re.fullmatch(r"\d{1,2}:\d{2}", time.strip()):
        raise ValueError("время — в виде 15:00")
    parts = [title]
    if time.strip():
        h, m = time.strip().split(":")
        parts.append(f"🕒 {int(h):02d}:{m}")
    if place.strip():
        parts.append(f"📍 {re.sub(r'[#🕒📍]', '', place).strip()}")
    return " ".join(parts)


def _get(t: Any, key: str):
    return t.get(key) if isinstance(t, dict) else getattr(t, key)


def assignees(tags: list[str]) -> list[str]:
    return [t[len(OP_TAG):] for t in tags if t.startswith(OP_TAG) and len(t) > len(OP_TAG)]


def is_meeting(task: Any) -> bool:
    return MEET_TAG in (_get(task, "tags") or [])


def as_meeting(task: Any) -> dict:
    d = task if isinstance(task, dict) else task.as_dict()
    text = d["text"]
    tm, pl = TIME.search(text), PLACE.search(text)
    title = PLACE.sub("", TIME.sub("", text))
    title = re.sub(r"\s{2,}", " ", title).strip()
    return {**d, "title": title, "time": tm.group(1).zfill(5) if tm else "", "place": pl.group(1).strip() if pl else "",
            "assignees": assignees(d.get("tags") or [])}


def for_operator(tasks: list, op_slug: str | None) -> list:
    """Задачи, порученные оператору (op_slug None — все)."""
    if op_slug is None:
        return list(tasks)
    tag = OP_TAG + op_slug
    return [t for t in tasks if tag in (_get(t, "tags") or [])]


def meetings(tasks: list, ref_iso: str, *, op_slug: str | None = None, past_days: int = 7) -> dict:
    """Встречи: предстоящие (по дате и времени; без даты — в конце) и прошедшие/отмеченные за past_days дней."""
    items = [as_meeting(t) for t in for_operator([t for t in tasks if is_meeting(t)], op_slug)]
    upcoming = [m for m in items if m["status"] in ("todo", "doing")]
    upcoming.sort(key=lambda m: (m["due"] or "9999-99-99", m["time"] or "99:99", m["title"]))
    done = [m for m in items if m["status"] in ("done", "cancelled")]
    cutoff = _shift(ref_iso, -past_days)
    done = [m for m in done if (m.get("done") or m.get("due") or "") >= cutoff]
    done.sort(key=lambda m: (m.get("done") or m["due"] or "", m["time"]), reverse=True)
    overdue = [m for m in upcoming if m["due"] and m["due"] < ref_iso]
    return {"upcoming": upcoming, "done": done, "overdue": len(overdue),
            "today": sum(1 for m in upcoming if m["due"] == ref_iso)}


def _shift(iso: str, days: int) -> str:
    from datetime import date, timedelta
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()
