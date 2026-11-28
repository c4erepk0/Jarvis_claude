"""Голос Atom: выбор движка, подготовка текста, запросы к платным синтезаторам и кэш."""
import json
from urllib.parse import parse_qs

import pytest

from jarvis.voice import Voice, speed_of, speakable


class FakeHTTP:
    """Подменяет сеть: запоминает запрос и возвращает заранее заданный ответ."""

    def __init__(self, status=200, body=b"ID3audio"):
        self.status, self.body = status, body
        self.calls = []

    async def __call__(self, url, headers, payload, content_type):
        self.calls.append({"url": url, "headers": headers, "payload": payload, "type": content_type})
        return self.status, self.body


def voice(tmp_path, engine, **kw):
    fake = kw.pop("transport", None) or FakeHTTP()
    v = Voice(engine, kw.pop("name", "filipp"), "-4%", "", tmp_path, transport=fake, **kw)
    return v, fake


def test_speakable_strips_markup():
    assert speakable("**Привет** `код` [ссылка](https://x)") == "Привет код ссылка"
    assert speakable("Цена 300₽ и 5% − итог") == "Цена 300 рублей и 5 процентов минус итог"
    assert speakable("😀 Текст") == "Текст"
    assert speakable("# Заголовок\n- пункт") == "Заголовок пункт"


def test_speed_from_rate():
    assert speed_of("-4%") == pytest.approx(0.96)
    assert speed_of("+10%") == pytest.approx(1.1)
    assert speed_of("") == 1.0 and speed_of("быстро") == 1.0
    assert speed_of("-200%") == 0.1 and speed_of("+900%") == 3.0


def test_browser_has_no_server_voice(tmp_path):
    v, fake = voice(tmp_path, "browser")
    assert v.server_side is False
    assert __import__("asyncio").run(v.synthesize("Привет")) is None
    assert fake.calls == []


def test_yandex_payload(tmp_path):
    v, fake = voice(tmp_path, "yandex", api_key="key-1", folder_id="b1g", name="filipp", style="good")
    data, mime = __import__("asyncio").run(v.synthesize("Привет, сэр. Как дела?"))
    assert data == b"ID3audio" and mime == "audio/mpeg"
    call = fake.calls[0]
    assert call["url"] == "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize"
    assert call["headers"]["Authorization"] == "Api-Key key-1"
    form = parse_qs(call["payload"].decode())
    assert form["text"] == ["Привет, сэр. Как дела?"] and form["voice"] == ["filipp"]
    assert form["folderId"] == ["b1g"] and form["speed"] == ["0.96"] and form["emotion"] == ["good"]
    assert call["type"] == "application/x-www-form-urlencoded"


def test_yandex_without_folder_falls_back(tmp_path):
    v, fake = voice(tmp_path, "yandex", api_key="key-1", folder_id="")
    assert __import__("asyncio").run(v.synthesize("Привет")) is None      # без каталога не зовём API
    assert fake.calls == []


def test_openai_payload_with_style(tmp_path):
    v, fake = voice(tmp_path, "openai", api_key="sk", model="gpt-4o-mini-tts", name="onyx",
                    style="говори спокойно и тепло", url="https://proxy.example/v1")
    data, mime = __import__("asyncio").run(v.synthesize("Добрый вечер"))
    assert data == b"ID3audio" and mime == "audio/mpeg"
    call = fake.calls[0]
    assert call["url"] == "https://proxy.example/v1/audio/speech"
    assert call["headers"]["Authorization"] == "Bearer sk"
    body = json.loads(call["payload"])
    assert body == {"model": "gpt-4o-mini-tts", "voice": "onyx", "input": "Добрый вечер",
                    "response_format": "mp3", "instructions": "говори спокойно и тепло"}


def test_eleven_payload_and_voice(tmp_path):
    v, fake = voice(tmp_path, "eleven", api_key="el", name="21m00Tcm4TlvDq8ikWAM", model="eleven_multilingual_v2")
    __import__("asyncio").run(v.synthesize("Привет"))
    call = fake.calls[0]
    assert call["url"].startswith("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM")
    assert "output_format=mp3_44100_128" in call["url"]
    assert call["headers"]["xi-api-key"] == "el"
    body = json.loads(call["payload"])
    assert body["model_id"] == "eleven_multilingual_v2" and body["voice_settings"]["stability"] == 0.5


def test_cache_avoids_second_request(tmp_path):
    v, fake = voice(tmp_path, "openai", api_key="sk")
    first = __import__("asyncio").run(v.synthesize("Повтор"))
    second = __import__("asyncio").run(v.synthesize("Повтор"))
    assert first == second and len(fake.calls) == 1


def test_error_returns_none_and_no_cache(tmp_path):
    fake = FakeHTTP(status=401, body=b"unauthorized")
    v, _ = voice(tmp_path, "openai", api_key="bad", transport=fake)
    assert __import__("asyncio").run(v.synthesize("Привет")) is None
    assert list(tmp_path.glob("*.mp3")) == []


def test_missing_key_is_not_fatal(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("TTS_KEY", raising=False)
    fake = FakeHTTP()
    v = Voice("openai", "onyx", "", "", tmp_path, transport=fake)
    assert __import__("asyncio").run(v.synthesize("Привет")) is None
    assert fake.calls == []


def test_edge_keeps_russian_voice(tmp_path):
    v, _ = voice(tmp_path, "edge", name="en-GB-RyanNeural")
    assert v.pick_voice("Привет") == "ru-RU-DmitryNeural"
    ru, _ = voice(tmp_path, "edge", name="ru-RU-DmitryNeural")
    assert ru.pick_voice("Привет") == "ru-RU-DmitryNeural"
    assert ru.pick_voice("Hello") == "ru-RU-DmitryNeural"
