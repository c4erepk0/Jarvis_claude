"""Данные для брифинга из бесплатных источников без ключей: погода (Open-Meteo) и курсы (ЦБ РФ)."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import aiohttp

log = logging.getLogger("jarvis.briefing")

WMO = {
    0: "ясно", 1: "преимущественно ясно", 2: "переменная облачность", 3: "пасмурно", 45: "туман",
    48: "изморозь и туман", 51: "лёгкая морось", 53: "морось", 55: "сильная морось", 56: "ледяная морось",
    57: "сильная ледяная морось", 61: "небольшой дождь", 63: "дождь", 65: "сильный дождь",
    66: "ледяной дождь", 67: "сильный ледяной дождь", 71: "небольшой снег", 73: "снег", 75: "сильный снег",
    77: "снежные зёрна", 80: "ливень", 81: "сильный ливень", 82: "очень сильный ливень",
    85: "снегопад", 86: "сильный снегопад", 95: "гроза", 96: "гроза с градом", 99: "сильная гроза с градом",
}


class Briefing:
    def __init__(self, lat: float, lon: float, city: str, tz: str,
                 weather_url: str = "https://api.open-meteo.com/v1/forecast",
                 rates_url: str = "https://www.cbr-xml-daily.ru/daily_json.js"):
        self.lat, self.lon, self.city, self.tz = lat, lon, city, tz
        self.weather_url, self.rates_url = weather_url, rates_url
        self._cache: dict[str, tuple[float, Any]] = {}
        self._session: aiohttp.ClientSession | None = None

    async def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8), trust_env=True,
                                                  headers={"User-Agent": "jarvis-dashboard"})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def _cached(self, key: str, ttl: float, factory) -> Any:
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return hit[1]
        try:
            value = await factory()
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, KeyError) as e:
            log.info("%s недоступно: %s", key, e)
            return hit[1] if hit else None
        self._cache[key] = (time.monotonic(), value)
        return value

    async def weather(self) -> dict | None:
        async def load():
            params = {
                "latitude": self.lat, "longitude": self.lon, "timezone": self.tz,
                "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,"
                         "sunrise,sunset",
                "forecast_days": 2, "wind_speed_unit": "ms",
            }
            s = await self.session()
            async with s.get(self.weather_url, params=params) as r:
                r.raise_for_status()
                d = await r.json(content_type=None)
            cur, day = d["current"], d["daily"]
            return {
                "city": self.city,
                "temp": round(cur["temperature_2m"]), "feels": round(cur["apparent_temperature"]),
                "code": cur["weather_code"], "text": WMO.get(cur["weather_code"], "—"),
                "wind": round(cur["wind_speed_10m"]), "humidity": cur.get("relative_humidity_2m"),
                "max": round(day["temperature_2m_max"][0]), "min": round(day["temperature_2m_min"][0]),
                "rain": day["precipitation_probability_max"][0],
                "sunrise": day["sunrise"][0][-5:], "sunset": day["sunset"][0][-5:],
                "tomorrow": {"max": round(day["temperature_2m_max"][1]), "min": round(day["temperature_2m_min"][1]),
                             "text": WMO.get(day["weather_code"][1], "—")},
            }
        return await self._cached("weather", 900, load)

    async def rates(self) -> dict | None:
        async def load():
            s = await self.session()
            async with s.get(self.rates_url) as r:
                r.raise_for_status()
                d = await r.json(content_type=None)
            out = {}
            for code in ("USD", "EUR", "CNY"):
                v = d["Valute"].get(code)
                if v:
                    out[code] = {"value": round(v["Value"] / v.get("Nominal", 1), 2),
                                 "delta": round((v["Value"] - v["Previous"]) / v.get("Nominal", 1), 2)}
            return out
        return await self._cached("rates", 3600, load)

    @staticmethod
    def weather_phrase(w: dict | None) -> str:
        if not w:
            return "Метеосводка сейчас недоступна."
        sign = "+" if w["temp"] > 0 else ""
        s = (f"В городе {w['city']} {sign}{w['temp']}°, {w['text']}, ощущается как {w['feels']}°. "
             f"Днём от {w['min']} до {w['max']}°")
        if w.get("rain") and w["rain"] >= 40:
            s += f", вероятность осадков {w['rain']}% — зонт не помешает"
        return s + "."

    @staticmethod
    def rates_phrase(r: dict | None) -> str:
        if not r:
            return ""
        parts = []
        for code, name in (("USD", "доллар"), ("EUR", "евро")):
            if code in r:
                parts.append(f"{name} {r[code]['value']:.2f}".replace(".", ","))
        return ("Курс ЦБ: " + ", ".join(parts) + ".") if parts else ""
