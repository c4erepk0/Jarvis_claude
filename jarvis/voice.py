"""Голос Jarvis: синтез речи на сервере.

- `edge`  — нейроголоса Microsoft Edge (бесплатно, без ключа; нужен интернет). По умолчанию
  ru-RU-DmitryNeural, чуть медленнее и ниже — спокойная манера дворецкого. Для речи с британским
  акцентом — en-US-BrianMultilingualNeural, для ответов на английском — en-GB-RyanNeural.
- `piper` — полностью локальный синтез (https://github.com/rhasspy/piper), голос — любая .onnx-модель,
  на которую у вас есть права.
- `browser` — синтез средствами браузера/телефона (speechSynthesis), сервер звук не отдаёт.

«Металлический» оттенок и лёгкое эхо голоса из фильма добавляет дашборд (Web Audio), а не сервер:
так можно выключить эффект одной кнопкой. Голос конкретного актёра Jarvis не клонирует.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import shutil
import tempfile
from pathlib import Path

log = logging.getLogger("jarvis.voice")
CYRILLIC = re.compile(r"[а-яё]", re.I)
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️‍]")


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


class Voice:
    def __init__(self, engine: str, voice: str, rate: str, pitch: str, cache_dir: Path,
                 piper_bin: str = "piper", piper_model: str = ""):
        self.engine = engine
        self.voice = voice
        self.rate = rate
        self.pitch = pitch
        self.piper_bin = piper_bin
        self.piper_model = piper_model
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.muted = False

    @property
    def server_side(self) -> bool:
        return self.engine in ("edge", "piper") and not self.muted

    def pick_voice(self, text: str) -> str:
        """Английский голос не умеет кириллицу — для русского текста берём русский."""
        if CYRILLIC.search(text) and not (self.voice.startswith("ru-") or "Multilingual" in self.voice):
            return "ru-RU-DmitryNeural"
        return self.voice

    async def synthesize(self, text: str) -> tuple[bytes, str] | None:
        text = speakable(text)
        if not text or not self.server_side:
            return None
        voice = self.pick_voice(text)
        key = hashlib.sha1(f"{self.engine}|{voice}|{self.rate}|{self.pitch}|{text}".encode()).hexdigest()
        ext, mime = ("mp3", "audio/mpeg") if self.engine == "edge" else ("wav", "audio/wav")
        cached = self.cache_dir / f"{key}.{ext}"
        if cached.exists():
            return cached.read_bytes(), mime
        try:
            data = await (self._edge(text, voice) if self.engine == "edge" else self._piper(text))
        except Exception as e:  # noqa: BLE001 — нет сети/модели → дашборд озвучит сам
            log.warning("синтез речи не удался (%s): %s", self.engine, e)
            return None
        if not data:
            return None
        cached.write_bytes(data)
        self._trim_cache()
        return data, mime

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

    def _trim_cache(self, keep: int = 300) -> None:
        files = sorted(self.cache_dir.glob("*.*"), key=lambda p: p.stat().st_mtime)
        for f in files[:-keep]:
            try:
                f.unlink()
            except OSError:
                pass
