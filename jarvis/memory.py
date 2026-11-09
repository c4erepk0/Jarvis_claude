"""Долговременная память Jarvis в Obsidian.

- `Jarvis/Memory.md` — факты о владельце: «- 2026-11-08 — предпочитает кофе без сахара»;
- `Jarvis/Profile.md` — свободный текст «обо мне», который Jarvis учитывает в каждом разговоре;
- `Jarvis/Conversations/2026-11-08.md` — журнал разговоров по дням;
- `Journal/2026-11-08.md` — ежедневная заметка, куда Jarvis пишет события дня.
"""
from __future__ import annotations

import re
from datetime import datetime

from .vault import Vault, parse_frontmatter

FACT = re.compile(r"^- (?:(\d{4}-\d{2}-\d{2}) — )?(.+)$")


class Memory:
    def __init__(self, vault: Vault, jarvis_dir: str = "Jarvis", journal_dir: str = "Journal"):
        self.vault = vault
        self.dir = jarvis_dir.strip("/")
        self.journal_dir = journal_dir.strip("/")

    @property
    def memory_path(self) -> str:
        return f"{self.dir}/Memory.md"

    @property
    def profile_path(self) -> str:
        return f"{self.dir}/Profile.md"

    # ---------- факты ----------
    def facts(self) -> list[dict]:
        if not self.vault.exists(self.memory_path):
            return []
        out = []
        for line in self.vault.read(self.memory_path).splitlines():
            m = FACT.match(line.strip())
            if m:
                out.append({"date": m.group(1), "text": m.group(2).strip()})
        return out

    def remember(self, fact: str, when: datetime) -> dict:
        fact = re.sub(r"\s+", " ", fact).strip().rstrip(".")
        if not fact:
            raise ValueError("пустой факт")
        if any(f["text"].lower() == fact.lower() for f in self.facts()):
            return {"date": None, "text": fact, "duplicate": True}
        day = when.date().isoformat()
        self.vault.append_to_section(self.memory_path, "Факты", f"- {day} — {fact}",
                                     header="# Память Jarvis\n\nЗдесь Jarvis хранит то, что узнал о вас. "
                                            "Можно править вручную.\n\n")
        return {"date": day, "text": fact}

    def forget(self, needle: str) -> int:
        if not self.vault.exists(self.memory_path):
            return 0
        needle = needle.lower().strip()
        if len(needle) < 3:
            return 0
        lines = self.vault.read(self.memory_path).splitlines()
        keep = [ln for ln in lines if not (FACT.match(ln.strip()) and needle in ln.lower())]
        removed = len(lines) - len(keep)
        if removed:
            self.vault.write(self.memory_path, "\n".join(keep) + "\n")
        return removed

    def profile(self) -> str:
        if not self.vault.exists(self.profile_path):
            return ""
        _, body = parse_frontmatter(self.vault.read(self.profile_path))
        return body.strip()

    # ---------- журнал дня ----------
    def journal_path(self, when: datetime) -> str:
        return f"{self.journal_dir}/{when.date().isoformat()}.md"

    def log_event(self, text: str, when: datetime) -> None:
        path = self.journal_path(when)
        header = f"# {when.date().isoformat()}\n\n"
        self.vault.append_to_section(path, "Журнал Jarvis", f"- {when:%H:%M} {text}", header=header)

    def log_dialog(self, user_text: str, reply: str, when: datetime, source: str = "") -> None:
        path = f"{self.dir}/Conversations/{when.date().isoformat()}.md"
        src = f" · {source}" if source and source != "dashboard" else ""
        block = (f"\n**Вы ({when:%H:%M}{src}):** {user_text.strip()}\n\n"
                 f"**Jarvis:** {reply.strip()}\n")
        self.vault.append(path, block, header=f"# Разговоры — {when.date().isoformat()}\n")

    def recent_dialog(self, when: datetime, limit_chars: int = 2500) -> str:
        path = f"{self.dir}/Conversations/{when.date().isoformat()}.md"
        if not self.vault.exists(path):
            return ""
        return self.vault.read(path)[-limit_chars:]
