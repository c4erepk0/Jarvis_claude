"""Общие заготовки для тестов: Jarvis с временным хранилищем, без сети и без ключей."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from jarvis.briefing import Briefing
from jarvis.config import Config
from jarvis.core import Jarvis
from jarvis.github import GitHub

ROOT = Path(__file__).resolve().parent.parent
for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"):
    os.environ.pop(key, None)


class FakeBriefing(Briefing):
    def __init__(self):
        super().__init__(55.75, 37.62, "Москва", "Europe/Moscow")

    async def weather(self):
        return {"city": "Москва", "temp": 3, "feels": -1, "code": 3, "text": "пасмурно", "wind": 4, "humidity": 80,
                "max": 5, "min": 1, "rain": 60, "sunrise": "07:41", "sunset": "16:34",
                "tomorrow": {"max": 4, "min": 0, "text": "снег"}}

    async def rates(self):
        return {"USD": {"value": 81.5, "delta": 0.2}, "EUR": {"value": 92.1, "delta": -0.1}}


def make_config(tmp: Path, **kw) -> Config:
    base = dict(vault_path=tmp / "vault", data_dir=tmp / "data", tts_engine="browser", github_token="",
                briefing_time="", claude_code_bin="definitely-not-installed-claude")
    base.update(kw)
    return Config(**base)


def make_jarvis(tmp: Path, *, seed: bool = True, github: GitHub | None = None, llm=None, **kw) -> Jarvis:
    cfg = make_config(tmp, **kw)
    if seed:
        shutil.copytree(ROOT / "vault-template", cfg.vault_path, dirs_exist_ok=True)
    return Jarvis(cfg, github=github or GitHub("", base_url="http://127.0.0.1:9"), briefing=FakeBriefing(), llm=llm)


@pytest.fixture
def jarvis(tmp_path):
    return make_jarvis(tmp_path)
