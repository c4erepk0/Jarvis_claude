// Карта и навигация — логика без DOM и без MapLibre (тест — tests/js/geo.test.mjs):
// расстояния, форматирование, подсказки манёвров по-русски из шагов OSRM, сход с маршрута, разбор ответов
// Photon / Nominatim / OSRM / Overpass. Координаты — [lon, lat], как в GeoJSON и MapLibre.

export const NYC = { center: [-73.9857, 40.7484], zoom: 13.2, pitch: 55, bearing: -17 };

/** Обзор Нью-Йорка: камера облетает места по очереди (кнопка «Нью-Йорк»). */
export const NYC_TOUR = [
  { name: "Таймс-сквер", center: [-73.9855, 40.758], zoom: 16.6, pitch: 62, bearing: 30 },
  { name: "Эмпайр-стейт-билдинг", center: [-73.9857, 40.7484], zoom: 16.4, pitch: 65, bearing: -40 },
  { name: "Центральный парк", center: [-73.9654, 40.7829], zoom: 14.2, pitch: 50, bearing: 29 },
  { name: "Бруклинский мост", center: [-73.9969, 40.7061], zoom: 15.8, pitch: 60, bearing: 70 },
  { name: "Всемирный торговый центр", center: [-74.0134, 40.7127], zoom: 16.2, pitch: 65, bearing: -20 },
  { name: "Статуя Свободы", center: [-74.0445, 40.6892], zoom: 15.6, pitch: 55, bearing: 120 },
];

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Расстояние по поверхности Земли, метры. */
export function distance([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Длина ломаной, метры. */
export const lineLength = (coords) => coords.slice(1).reduce((s, c, i) => s + distance(coords[i], c), 0);

/** Направление с a на b, градусы от севера по часовой (0..360). */
export function bearing([lon1, lat1], [lon2, lat2]) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function formatDistance(m) {
  if (!Number.isFinite(m)) return "—";
  if (m < 50) return `${Math.max(0, Math.round(m))} м`;
  if (m < 1000) return `${Math.round(m / 10) * 10} м`;
  if (m < 10000) return `${(m / 1000).toFixed(1).replace(".", ",")} км`;
  return `${Math.round(m / 1000)} км`;
}

export function formatDuration(s) {
  if (!Number.isFinite(s)) return "—";
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/** Время прибытия: «в 14:05». */
export function arrival(seconds, now = new Date()) {
  const t = new Date(now.getTime() + seconds * 1000);
  return `в ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** «40.7484, -73.9857» или «40.7484 -73.9857» → [lon, lat]; не координаты — null. */
export function parseCoords(text) {
  const m = /^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/.exec(String(text || ""));
  if (!m) return null;
  const lat = Number(m[1].replace(",", ".")), lon = Number(m[2].replace(",", "."));
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

export const coordsText = ([lon, lat]) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

/** Ссылка, которую можно отправить: откроется на любой карте (geo:) или в браузере (OSM). */
export const shareLink = ([lon, lat], zoom = 17) =>
  `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=${Math.round(zoom)}/${lat.toFixed(6)}/${lon.toFixed(6)}`;

// ---------- манёвры OSRM → подсказки ----------
const SIDE = { left: "налево", right: "направо", "slight left": "плавно налево", "slight right": "плавно направо",
  "sharp left": "резко налево", "sharp right": "резко направо", straight: "прямо", uturn: "развернитесь" };
const ICON = { left: "↰", right: "↱", "slight left": "↖", "slight right": "↗", "sharp left": "↰", "sharp right": "↱",
  straight: "↑", uturn: "↶" };
const ORD = ["", "первый", "второй", "третий", "четвёртый", "пятый", "шестой"];
const onto = (name) => (name ? ` на ${name}` : "");

/** Шаг OSRM ({ maneuver: { type, modifier, exit }, name }) → { text, icon }. */
export function instruction(step) {
  const m = step.maneuver || {}, mod = m.modifier || "straight", name = step.name || "";
  switch (m.type) {
    case "depart": return { text: `Начните движение${name ? ` по ${name}` : ""}`, icon: "●" };
    case "arrive": return { text: m.modifier && m.modifier !== "straight" ? `Вы на месте — цель ${mod.includes("left") ? "слева" : "справа"}` : "Вы на месте", icon: "⚑" };
    case "roundabout": case "rotary": case "exit roundabout": case "exit rotary":
      return { text: `На круге — ${ORD[m.exit] || `${m.exit || ""}-й`} съезд${onto(name)}`.replace(" -й", ""), icon: "⟳" };
    case "merge": return { text: `Перестройтесь ${SIDE[mod] || ""}${onto(name)}`.replace("  ", " "), icon: ICON[mod] || "↑" };
    case "on ramp": return { text: `Заезд ${SIDE[mod] || ""}${onto(name)}`.replace("  ", " "), icon: ICON[mod] || "↗" };
    case "off ramp": return { text: `Съезд ${SIDE[mod] || ""}${onto(name)}`.replace("  ", " "), icon: ICON[mod] || "↘" };
    case "fork": return { text: `На развилке держитесь ${mod.includes("left") ? "левее" : mod.includes("right") ? "правее" : "прямо"}${onto(name)}`, icon: ICON[mod] || "↑" };
    case "continue": case "new name":
      return mod === "straight" ? { text: `Продолжайте прямо${onto(name)}`, icon: "↑" } : { text: `Держитесь ${SIDE[mod]}${onto(name)}`, icon: ICON[mod] || "↑" };
    case "end of road": case "turn": default:
      if (mod === "uturn") return { text: `Развернитесь${onto(name)}`, icon: "↶" };
      if (mod === "straight") return { text: `Прямо${onto(name)}`, icon: "↑" };
      return { text: `Поверните ${SIDE[mod] || ""}${onto(name)}`.replace("  ", " "), icon: ICON[mod] || "↑" };
  }
}

/** Что сказать голосом перед манёвром: «Через 200 метров поверните направо на Бродвей». */
export function spoken(step, meters) {
  const t = instruction(step).text;
  if (meters < 30) return t;
  const d = meters < 1000 ? `${Math.round(meters / 50) * 50 || 50} метров` : `${(meters / 1000).toFixed(1).replace(".", ",")} километра`;
  return `Через ${d} ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
}

// ---------- положение относительно маршрута ----------
/** Ближайшая точка ломаной к p: { dist (м), index (номер отрезка), along (м от начала) }. */
export function nearestOnLine(coords, p) {
  let best = { dist: Infinity, index: 0, along: 0 };
  let walked = 0;
  const kx = Math.cos(rad(p[1]));        // равнопромежуточная проекция — точности хватает на сотни метров
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const ax = (a[0] - p[0]) * kx, ay = a[1] - p[1], bx = (b[0] - p[0]) * kx, by = b[1] - p[1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const d = distance(p, q), seg = distance(a, b);
    if (d < best.dist) best = { dist: d, index: i, along: walked + seg * t, point: q };
    walked += seg;
  }
  return best;
}

/**
 * Где мы на маршруте: следующий шаг, сколько до него, сколько осталось, не ушли ли с маршрута.
 * route — из parseRoute(); offRoute — дальше tolerance метров от линии.
 */
export function progress(route, p, tolerance = 45) {
  const near = nearestOnLine(route.coords, p);
  const left = Math.max(0, route.distance - near.along);
  let next = route.steps.length - 1;
  for (let i = 0; i < route.steps.length; i++) { if (route.steps[i].at > near.along + 5) { next = i; break; } }
  const step = route.steps[next];
  const toStep = Math.max(0, step.at - near.along);
  const share = route.distance ? left / route.distance : 0;
  return { offRoute: near.dist > tolerance, distanceFromRoute: near.dist, along: near.along, left, next, step, toStep,
    timeLeft: route.duration * share, arrived: left < 25 || (next === route.steps.length - 1 && toStep < 20) };
}

// ---------- разбор ответов сервисов ----------
/** Ответ OSRM (geometries=geojson, steps=true) → маршруты { coords, distance, duration, steps: [{…, at, text, icon}] }. */
export function parseRoute(osrm) {
  if (!osrm || osrm.code !== "Ok" || !osrm.routes?.length) return [];
  return osrm.routes.map((r) => {
    let at = 0;
    const steps = (r.legs || []).flatMap((leg) => leg.steps || []).map((s) => {
      const out = { ...instruction(s), name: s.name || "", distance: s.distance, duration: s.duration, at,
        location: s.maneuver?.location, maneuver: s.maneuver };
      at += s.distance;
      return out;
    });
    return { coords: r.geometry.coordinates, distance: r.distance, duration: r.duration, steps };
  });
}

/** Профиль маршрута → адрес OSRM (routing.openstreetmap.de держит все три профиля). */
export const PROFILES = {
  car: { label: "Авто", icon: "🚗", base: "https://routing.openstreetmap.de/routed-car/route/v1/driving" },
  foot: { label: "Пешком", icon: "🚶", base: "https://routing.openstreetmap.de/routed-foot/route/v1/driving" },
  bike: { label: "Велосипед", icon: "🚲", base: "https://routing.openstreetmap.de/routed-bike/route/v1/driving" },
};
export function routeUrl(profile, points, { alternatives = true } = {}) {
  const p = PROFILES[profile] || PROFILES.car;
  const path = points.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(";");
  return `${p.base}/${path}?overview=full&geometries=geojson&steps=true&alternatives=${alternatives && points.length === 2 ? "true" : "false"}`;
}

/** Photon (GeoJSON) → места { name, address, center, kind }. */
export function parsePhoton(json) {
  return (json?.features || []).map((f) => {
    const p = f.properties || {};
    const street = [p.street, p.housenumber].filter(Boolean).join(", ");
    const parts = [street, p.district || p.locality, p.city || p.county, p.state, p.country].filter(Boolean);
    const name = p.name || street || p.city || p.country || "Без названия";
    return { name, address: [...new Set(parts)].filter((x) => x !== name).join(", "), center: f.geometry.coordinates,
      kind: p.osm_value || p.type || "", extent: p.extent || null };
  });
}

/** Nominatim reverse (jsonv2) → место. */
export function parseNominatim(json) {
  if (!json || json.error) return null;
  const a = json.address || {};
  const street = [a.road || a.pedestrian, a.house_number].filter(Boolean).join(", ");
  const name = json.name || street || a.neighbourhood || a.suburb || a.city || "Точка на карте";
  return { name, address: [street, a.suburb || a.neighbourhood, a.city || a.town || a.village, a.country].filter((x) => x && x !== name).join(", "),
    center: [Number(json.lon), Number(json.lat)], kind: json.type || "" };
}

/** Категории «Рядом» → запросы Overpass по тегам OSM. */
export const NEARBY = {
  cafe: { label: "Кафе", icon: "☕", q: '["amenity"~"^(cafe|restaurant|fast_food)$"]' },
  pharmacy: { label: "Аптеки", icon: "💊", q: '["amenity"="pharmacy"]' },
  atm: { label: "Банкоматы", icon: "🏧", q: '["amenity"~"^(atm|bank)$"]' },
  metro: { label: "Метро", icon: "🚇", q: '["railway"~"^(station|subway_entrance)$"]' },
  fuel: { label: "АЗС", icon: "⛽", q: '["amenity"="fuel"]' },
  hotel: { label: "Отели", icon: "🛏", q: '["tourism"~"^(hotel|hostel)$"]' },
  shop: { label: "Магазины", icon: "🛒", q: '["shop"~"^(supermarket|convenience)$"]' },
  parking: { label: "Парковки", icon: "🅿", q: '["amenity"="parking"]' },
};
/** Запрос Overpass: категория в прямоугольнике [w, s, e, n]. */
export function overpassQuery(kind, [w, s, e, n], limit = 60) {
  const q = (NEARBY[kind] || NEARBY.cafe).q, bbox = `${s},${w},${n},${e}`;
  return `[out:json][timeout:20];(node${q}(${bbox});way${q}(${bbox}););out center ${limit};`;
}
/** Ответ Overpass → места, ближайшие к точке — первыми. */
export function parseOverpass(json, from) {
  return (json?.elements || []).map((el) => {
    const t = el.tags || {};
    const center = el.type === "node" ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null;
    if (!center) return null;
    const address = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(", ");
    return { name: t.name || t.brand || t.operator || "Без названия", address, center, kind: t.amenity || t.shop || t.tourism || t.railway || "",
      hours: t.opening_hours || "", phone: t.phone || t["contact:phone"] || "", site: t.website || t["contact:website"] || "",
      dist: from ? distance(from, center) : null };
  }).filter(Boolean).sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
}

// Русские названия мест Нью-Йорка в любом падеже → запрос, который поймёт геопоиск (основа слова → название).
const ALIASES = [
  [["таймс", "times sq"], "Times Square, New York"], [["эмпайр", "empire"], "Empire State Building"],
  [["центральн парк", "central park"], "Central Park, New York"],
  [["бруклинск мост", "brooklyn bridge"], "Brooklyn Bridge"], [["статуя свобод", "статуи свобод", "статую свобод"], "Statue of Liberty"],
  [["уолл", "wall st"], "Wall Street, New York"], [["бродве", "broadway"], "Broadway, New York"],
  [["манхэттен", "манхеттен"], "Manhattan, New York"], [["бруклин"], "Brooklyn, New York"], [["квинс"], "Queens, New York"],
  [["бронкс"], "Bronx, New York"], [["всемирн торгов", "торгов центр", "wtc"], "One World Trade Center"],
  [["рокфеллер"], "Rockefeller Center"], [["хай лайн", "хайлайн", "high line"], "High Line, New York"],
  [["гранд централ", "grand central"], "Grand Central Terminal"], [["пятая авеню", "пятой авеню", "5-я авеню", "5-й авеню"], "5th Avenue, New York"],
  [["метрополитен", "метрополитен-музе", "met museum"], "Metropolitan Museum of Art"], [["мома", "moma", "музей современ"], "Museum of Modern Art"],
  [["джфк", "jfk", "кеннеди"], "John F. Kennedy International Airport"], [["ла гуардия", "лагуардия"], "LaGuardia Airport"],
  [["кони", "coney"], "Coney Island"], [["чайнатаун", "чайна-таун"], "Chinatown, Manhattan"], [["сохо"], "SoHo, Manhattan"],
  [["нью-йорк", "нью йорк", "ньюйорк"], "New York City"],
];
const words = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);

/** «до центрального парка» → «Central Park, New York»; незнакомое — как есть. Ключ — начала слов подряд. */
export function localAlias(query) {
  const q = words(query);
  for (const [keys, name] of ALIASES) {
    for (const key of keys) {
      const k = words(key);
      for (let i = 0; i + k.length <= q.length; i++) {
        if (k.every((w, j) => q[i + j].startsWith(w))) return name;
      }
    }
  }
  return String(query || "").trim();
}
