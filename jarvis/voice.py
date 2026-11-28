"""Голос Atom: синтез речи на сервере.

Движки (`TTS_ENGINE`):
- `yandex` — **Yandex SpeechKit**: лучший русский голос из доступных без VPN и с оплатой в рублях.
  Эмоция (`TTS_STYLE`: good · neutral), скорость из `TTS_RATE`. Нужны `YANDEX_API_KEY` и `YANDEX_FOLDER_ID`.
- `openai` — OpenAI-совместимый синтез (`gpt-4o-mini-tts` и прокси/агрегаторы): понимает **инструкцию о манере**
  (`TTS_STYLE`), поэтому можно задать «спокойно, тепло, не спеша». Нужен `TTS_KEY` или `OPENAI_API_KEY`.
- `eleven` — ElevenLabs (`eleven_multilingual_v2`): самая живая интонация, но сервис закрыт для России
  (доступ через агрегаторы). Нужен `TTS_KEY` / `ELEVENLABS_API_KEY` и `TTS_VOICE`.
- `edge` — нейроголоса Microsoft Edge (бесплатно, без ключа; нужен интернет). По умолчанию
  ru-RU-DmitryNeural, чуть медленнее и ниже — спокойная манера дворецкого. Резерв, если платный синтез не настроен.
- `piper` — полностью локальный синтез (https://github.com/rhasspy/piper), голос — любая .onnx-модель.
- `browser` — синтез средствами браузера/телефона (speechSynthesis), сервер звук не отдаёт.

«Металлический» оттенок и лёгкое эхо голоса из фильма добавляет дашборд (Web Audio), а не сервер:
так можно выключить эффект одной кнопкой. Голос конкретного актёра Atom не клонирует.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlencode

log = logging.getLogger("jarvis.voice")
CYRILLIC = re.compile(r"[а-яё]", re.I)
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️‍]")

SERVER = ("edge", "piper", "yandex", "openai", "eleven")
MIME = {"edge": ("mp3", "audio/mpeg"), "yandex": ("mp3", "audio/mpeg"), "openai": ("mp3", "audio/mpeg"),
        "eleven": ("mp3", "audio/mpeg"), "piper": ("wav", "audio/wav")}
URLS = {"openai": "https://api.openai.com/v1", "eleven": "https://api.elevenlabs.io/v1",
        "yandex": "https://tts.api.cloud.yandex.net/speech/v1"}
KEY_ENV = {"openai": ("TTS_KEY", "OPENAI_API_KEY"), "eleven": ("TTS_KEY", "ELEVENLABS_API_KEY"),
           "yandex": ("TTS_KEY", "YANDEX_API_KEY", "YANDEX_SPEECHKIT_KEY")}


def speakable(text: str, limit: int = 900) -> str:
    """Готовит текст к озвучке: без markdown, ссылок, эмодзи и таблиц."""
    t = re.sub(r"```.*?```", " ", text, flags=re.S)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    t = re.sub(r"https?://\S+", "ссылка", t)
    t = re.sub(r"^\s*\|.*\|\s*$", " ", t, flags=re.M)
    t = re.sub(r"^\s*#+\s*", "", t, flags=re.M)
    t = re.sub(r"^\s*[-*•]\s+", "", t, flags=re.M)
    t = re.sub(r"[*_~>#]", "", t)
    t = EMOJI.sub("", t)
    t = t.replace("₽", " рублей").replace("°", " градусов").replace("%", " процентов").replace("−", "минус ")
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) > limit:
        cut = t[:limit]
        t = cut[: cut.rfind(". ") + 1] or cut
    return t


def speed_of(rate: str) -> float:
    """`-4%` → 0.96, `+10%` → 1.1; для Yandex это `speed`, у edge — своя строка `rate`."""
    m = re.fullmatch(r"\s*([+-]?\d+(?:[.,]\d+)?)\s*%\s*", str(rate or ""))
    if not m:
        return 1.0
    try:
        return max(0.1, min(3.0, 1 + float(m.group(1).replace(",", ".")) / 100))
    except ValueError:
        return 1.0


class Voice:
    def __init__(self, engine: str, voice: str, rate: str, pitch: str, cache_dir: Path,
                 piper_bin: str = "piper", piper_model: str = "", *, model: str = "", api_key: str = "",
                 url: str = "", style: str = "", folder_id: str = "", transport=None, timeout: float = 60.0):
        self.engine = engine
        self.voice = voice
        self.rate = rate
        self.pitch = pitch
        self.piper_bin = piper_bin
        self.piper_model = piper_model
        self.model = model
        self.api_key = api_key
        self.url = url
        self.style = style
        self.folder_id = folder_id
        self._transport = transport      # тесты: (url, headers, payload, content_type) → (status, bytes)
        self.timeout = timeout
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.muted = False

    @property
    def server_side(self) -> bool:
        return self.engine in SERVER and not self.muted

    def pick_voice(self, text: str) -> str:
        """Английский голос не умеет кириллицу — для русского текста берём русский (только edge)."""
        if self.engine != "edge":
            return self.voice
        if CYRILLIC.search(text) and not (self.voice.startswith("ru-") or "Multilingual" in self.voice):
            return "ru-RU-DmitryNeural"
        return self.voice

    def _key(self) -> str:
        for name in KEY_ENV.get(self.engine, ()):
            value = (self.api_key if name == "TTS_KEY" else "") or os.getenv(name, "")
            if value.strip():
                return value.strip()
        raise RuntimeError(f"{self.engine}: не задан ключ — TTS_KEY или {KEY_ENV.get(self.engine, ('?',))[1]}")

    def _base(self, engine: str) -> str:
        return (self.url or URLS[engine]).rstrip("/")

    async def synthesize(self, text: str) -> tuple[bytes, str] | None:
        text = speakable(text)
        if not text or not self.server_side:
            return None
        voice = self.pick_voice(text)
        ext, mime = MIME.get(self.engine, ("mp3", "audio/mpeg"))
        key = hashlib.sha1(f"{self.engine}|{voice}|{self.rate}|{self.pitch}|{self.model}|{self.style}|{text}"
                           .encode()).hexdigest()
        cached = self.cache_dir / f"{key}.{ext}"
        if cached.exists():
            return cached.read_bytes(), mime
        try:
            if self.engine == "edge":
                data = await self._edge(text, voice)
            elif self.engine == "piper":
                data = await self._piper(text)
            elif self.engine == "yandex":
                data = await self._yandex(text, voice)
            elif self.engine == "openai":
                data = await self._openai(text, voice)
            elif self.engine == "eleven":
                data = await self._eleven(text, voice)
            else:
                return None
        except Exception as e:  # noqa: BLE001 — нет сети/ключа → дашборд озвучит сам
            log.warning("синтез речи не удался (%s): %s", self.engine, e)
            return None
        if not data:
            return None
        cached.write_bytes(data)
        self._trim_cache()
        return data, mime

    # ---------- HTTP ----------
    async def _request(self, url: str, headers: dict, payload: bytes, content_type: str) -> tuple[int, bytes]:
        if self._transport is not None:
            return await self._transport(url, headers, payload, content_type)
        import aiohttp
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.timeout)) as session:
            async with session.post(url, data=payload, headers={**headers, "Content-Type": content_type}) as resp:
                return resp.status, await resp.read()

    @staticmethod
    def _ok(engine: str, status: int, body: bytes) -> bytes:
        if status != 200:
            raise RuntimeError(f"{engine}: HTTP {status} {body[:200].decode('utf-8', 'replace')}")
        if not body:
            raise RuntimeError(f"{engine}: пустой ответ")
        return body

    # ---------- движки ----------
    async def _edge(self, text: str, voice: str) -> bytes:
        import edge_tts  # импорт здесь: зависимость нужна только для движка edge

        com = edge_tts.Communicate(text, voice, rate=self.rate, pitch=self.pitch)
        chunks = []
        async for item in com.stream():
            if item.get("type") == "audio":
                chunks.append(item["data"])
        return b"".join(chunks)

    async def _piper(self, text: str) -> bytes:
        if not self.piper_model or not shutil.which(self.piper_bin):
            raise RuntimeError("piper не найден или не задан PIPER_MODEL")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.wav"
            proc = await asyncio.create_subprocess_exec(
                self.piper_bin, "--model", self.piper_model, "--output_file", str(out),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _, err = await asyncio.wait_for(proc.communicate(text.encode()), timeout=60)
            if proc.returncode != 0:
                raise RuntimeError(err.decode(errors="replace")[-300:])
            return out.read_bytes()

    async def _yandex(self, text: str, voice: str) -> bytes:
        """SpeechKit: POST формой, ответ — mp3. Эмоция — `good` (тёплая) или `neutral`."""
        if not self.folder_id:
            raise RuntimeError("Yandex SpeechKit: не задан YANDEX_FOLDER_ID")
        form = {"text": text, "lang": "ru-RU", "voice": voice or "filipp", "format": "mp3",
                "folderId": self.folder_id, "speed": f"{speed_of(self.rate):.2f}"}
        if self.style:
            form["emotion"] = self.style
        status, body = await self._request(f"{self._base('yandex')}/tts:synthesize",
                                           {"Authorization": f"Api-Key {self._key()}"},
                                           urlencode(form).encode(), "application/x-www-form-urlencoded")
        return self._ok("Yandex SpeechKit", status, body)

    async def _openai(self, text: str, voice: str) -> bytes:
        """OpenAI-совместимый /audio/speech: инструкция о манере — поле `instructions`."""
        payload = {"model": self.model or "gpt-4o-mini-tts", "voice": voice or "onyx",
                   "input": text, "response_format": "mp3"}
        if self.style:
            payload["instructions"] = self.style
        status, body = await self._request(f"{self._base('openai')}/audio/speech",
                                           {"Authorization": f"Bearer {self._key()}"},
                                           json.dumps(payload, ensure_ascii=False).encode(), "application/json")
        return self._ok("OpenAI TTS", status, body)

    async def _eleven(self, text: str, voice: str) -> bytes:
        """ElevenLabs: голос — id из библиотеки, модель — multilingual v2 (умеет русский)."""
        style = float(self.style) if re.fullmatch(r"0(\.\d+)?|1(\.0+)?", (self.style or "").strip()) else 0.2
        payload = {"text": text, "model_id": self.model or "eleven_multilingual_v2",
                   "voice_settings": {"stability": 0.5, "similarity_boost": 0.8, "style": style,
                                      "use_speaker_boost": True}}
        voice = voice or "21m00Tcm4TlvDq8ikWAM"
        status, body = await self._request(f"{self._base('eleven')}/text-to-speech/{voice}?output_format=mp3_44100_128",
                                           {"xi-api-key": self._key()},
                                           json.dumps(payload, ensure_ascii=False).encode(), "application/json")
        return self._ok("ElevenLabs", status, body)

    def _trim_cache(self, keep: int = 300) -> None:
        files = sorted(self.cache_dir.glob("*.*"), key=lambda p: p.stat().st_mtime)
        for f in files[:-keep]:
            try:
                f.unlink()
            except OSError:
                pass
