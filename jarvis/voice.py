"""Голос Atom: синтез речи на сервере.

Движки (`TTS_ENGINE`) — только бесплатные, без ключей и сторонних платных сервисов:
- `edge` — нейроголоса Microsoft Edge (по умолчанию): бесплатно, без регистрации, нужен интернет.
  Голоса выбираются списком (`VOICES`): Дмитрий — спокойный мужской, Светлана — мягкий женский.
- `piper` — полностью локальный синтез (https://github.com/rhasspy/piper), голос — любая .onnx-модель.
- `browser` — синтез средствами браузера/телефона (speechSynthesis), сервер звук не отдаёт.

Речь «не ломается»: текст режется по концу предложения, а не по случайному символу; скорость и высота
по умолчанию нейтральные (0%), чтобы не звучало роботом. «Металлический» эффект из фильма — это Web Audio
в дашборде, он выключен по умолчанию и включается галочкой «Эффект голоса».

«Металлический» оттенок и лёгкое эхо голоса из фильма добавляет дашборд (Web Audio), а не сервер:
так можно выключить эффект одной кнопкой. Голос конкретного актёра Atom не клонирует.
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

SERVER = ("edge", "piper")
MIME = {"edge": ("mp3", "audio/mpeg"), "piper": ("wav", "audio/wav")}
# Бесплатные русские голоса edge-tts: только те, что реально есть в сервисе (проверено list_voices).
VOICES = [("ru-RU-DmitryNeural", "Дмитрий — мужской, спокойный"),
          ("ru-RU-SvetlanaNeural", "Светлана — женский, мягкий")]
DEFAULT_VOICE = VOICES[0][0]


def speakable(text: str, limit: int = 1200) -> str:
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
        end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "), cut.rfind("… "))
        if end > 0:
            t = cut[: end + 1]
        else:
            t = cut[: cut.rfind(" ")] if " " in cut else cut        # ни слова не рвём пополам
    return t


class Voice:
    def __init__(self, engine: str, voice: str, rate: str, pitch: str, cache_dir: Path,
                 piper_bin: str = "piper", piper_model: str = ""):
        self.engine = engine
        self.voice = voice or DEFAULT_VOICE
        self.rate = rate
        self.pitch = pitch
        self.piper_bin = piper_bin
        self.piper_model = piper_model
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.muted = False

    @property
    def server_side(self) -> bool:
        return self.engine in SERVER and not self.muted

    def pick_voice(self, text: str) -> str:
        """Английский голос не умеет кириллицу — для русского текста берём русский."""
        if CYRILLIC.search(text) and not (self.voice.startswith("ru-") or "Multilingual" in self.voice):
            return DEFAULT_VOICE
        return self.voice

    async def synthesize(self, text: str) -> tuple[bytes, str] | None:
        text = speakable(text)
        if not text or not self.server_side:
            return None
        voice = self.pick_voice(text)
        ext, mime = MIME.get(self.engine, ("mp3", "audio/mpeg"))
        key = hashlib.sha1(f"{self.engine}|{voice}|{self.rate}|{self.pitch}|{text}".encode()).hexdigest()
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
