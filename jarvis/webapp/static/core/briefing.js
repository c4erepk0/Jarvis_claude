// Погода (Open-Meteo) и курсы ЦБ — бесплатно, без ключей, прямо из браузера.
const WMO = { 0: "ясно", 1: "преимущественно ясно", 2: "переменная облачность", 3: "пасмурно", 45: "туман",
  48: "изморозь и туман", 51: "лёгкая морось", 53: "морось", 55: "сильная морось", 61: "небольшой дождь", 63: "дождь",
  65: "сильный дождь", 66: "ледяной дождь", 71: "небольшой снег", 73: "снег", 75: "сильный снег", 77: "снежные зёрна",
  80: "ливень", 81: "сильный ливень", 82: "очень сильный ливень", 85: "снегопад", 86: "сильный снегопад", 95: "гроза",
  96: "гроза с градом", 99: "сильная гроза с градом" };

export class Briefing {
  constructor(settings, fetchImpl = (...a) => fetch(...a)) {
    this.s = settings;
    this.fetch = fetchImpl;
    this.cache = {};
  }

  async cached(key, ttl, load) {
    const hit = this.cache[key];
    if (hit && Date.now() - hit.t < ttl * 1000) return hit.v;
    try {
      const v = await load();
      this.cache[key] = { t: Date.now(), v };
      return v;
    } catch {
      return hit ? hit.v : null;
    }
  }

  weather() {
    return this.cached("weather", 900, async () => {
      const u = new URL("https://api.open-meteo.com/v1/forecast");
      const p = { latitude: this.s.lat, longitude: this.s.lon, timezone: "auto",
        current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
        daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
        forecast_days: 2, wind_speed_unit: "ms" };
      for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
      const r = await this.fetch(u.toString());
      if (!r.ok) throw new Error(`погода: HTTP ${r.status}`);
      const d = await r.json();
      const c = d.current, day = d.daily;
      return { city: this.s.city, temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature),
        text: WMO[c.weather_code] || "—", wind: Math.round(c.wind_speed_10m),
        max: Math.round(day.temperature_2m_max[0]), min: Math.round(day.temperature_2m_min[0]),
        rain: day.precipitation_probability_max[0],
        tomorrow: { max: Math.round(day.temperature_2m_max[1]), min: Math.round(day.temperature_2m_min[1]),
          text: WMO[day.weather_code[1]] || "—" } };
    });
  }

  rates() {
    return this.cached("rates", 3600, async () => {
      const r = await this.fetch("https://www.cbr-xml-daily.ru/daily_json.js");
      if (!r.ok) throw new Error(`курсы: HTTP ${r.status}`);
      const d = await r.json();
      const out = {};
      for (const code of ["USD", "EUR", "CNY"]) {
        const v = d.Valute[code];
        if (v) out[code] = { value: Math.round(v.Value / (v.Nominal || 1) * 100) / 100,
          delta: Math.round((v.Value - v.Previous) / (v.Nominal || 1) * 100) / 100 };
      }
      return out;
    });
  }

  static weatherPhrase(w) {
    if (!w) return "Метеосводка сейчас недоступна.";
    let s = `В городе ${w.city} ${w.temp > 0 ? "+" : ""}${w.temp}°, ${w.text}, ощущается как ${w.feels}°. Днём от ${w.min} до ${w.max}°`;
    if (w.rain >= 40) s += `, вероятность осадков ${w.rain}% — зонт не помешает`;
    return s + ".";
  }

  static ratesPhrase(r) {
    if (!r) return "";
    const parts = [["USD", "доллар"], ["EUR", "евро"]].filter(([c]) => r[c])
      .map(([c, n]) => `${n} ${r[c].value.toFixed(2).replace(".", ",")}`);
    return parts.length ? `Курс ЦБ: ${parts.join(", ")}.` : "";
  }
}
