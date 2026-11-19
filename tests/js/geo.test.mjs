// Карта и навигация: расстояния, подсказки манёвров, сход с маршрута, разбор ответов сервисов (geo.js).
import assert from "node:assert/strict";
import { test } from "node:test";

import { HERE_VIEW, WORLD, arrival, bearing, distance, formatDistance, formatDuration, instruction, lineLength, nearestOnLine,
  overpassQuery, parseCoords, parseNominatim, parseOverpass, parsePhoton, parseRoute, progress, routeUrl, shareLink,
  spoken } from "../../jarvis/webapp/static/geo.js";

const TIMES_SQ = [-73.9855, 40.758], EMPIRE = [-73.9857, 40.7484];

test("расстояние и направление", () => {
  const d = distance(TIMES_SQ, EMPIRE);
  assert.ok(d > 1000 && d < 1120, `${d}`);                 // ~1,07 км по прямой
  assert.ok(Math.abs(distance([0, 0], [1, 0]) - 111195) < 5);
  assert.ok(Math.abs(bearing(TIMES_SQ, EMPIRE) - 180) < 2);  // на юг
  assert.ok(Math.abs(bearing([0, 0], [1, 0]) - 90) < 1e-6);
  assert.ok(Math.abs(lineLength([[0, 0], [1, 0], [2, 0]]) - 222390) < 10);
  assert.ok(WORLD.zoom < 3 && HERE_VIEW.zoom > 14);         // без привязки к городу: мир, потом — где вы
});

test("форматирование по-русски", () => {
  assert.equal(formatDistance(12.4), "12 м");
  assert.equal(formatDistance(347), "350 м");
  assert.equal(formatDistance(1530), "1,5 км");
  assert.equal(formatDistance(23400), "23 км");
  assert.equal(formatDuration(30), "1 мин");
  assert.equal(formatDuration(3900), "1 ч 5 мин");
  assert.equal(formatDuration(7200), "2 ч");
  assert.equal(arrival(600, new Date(2026, 10, 18, 13, 55)), "в 14:05");
});

test("координаты из строки и ссылка", () => {
  assert.deepEqual(parseCoords("40.7484, -73.9857"), [-73.9857, 40.7484]);
  assert.deepEqual(parseCoords("55,7558 37,6173"), [37.6173, 55.7558]);   // десятичная запятая и пробел
  assert.deepEqual(parseCoords("55.7558 37.6173"), [37.6173, 55.7558]);
  assert.equal(parseCoords("Таймс-сквер"), null);
  assert.equal(parseCoords("95, 10"), null);
  assert.match(shareLink(EMPIRE), /mlat=40\.748400&mlon=-73\.985700/);
});

test("подсказки манёвров", () => {
  assert.equal(instruction({ maneuver: { type: "turn", modifier: "right" }, name: "Broadway" }).text, "Поверните направо на Broadway");
  assert.equal(instruction({ maneuver: { type: "turn", modifier: "slight left" }, name: "" }).text, "Поверните плавно налево");
  assert.equal(instruction({ maneuver: { type: "depart" }, name: "5th Avenue" }).text, "Начните движение по 5th Avenue");
  assert.equal(instruction({ maneuver: { type: "arrive", modifier: "left" } }).text, "Вы на месте — цель слева");
  assert.equal(instruction({ maneuver: { type: "roundabout", exit: 2 }, name: "Columbus Circle" }).text, "На круге — второй съезд на Columbus Circle");
  assert.equal(instruction({ maneuver: { type: "fork", modifier: "slight right" } }).text, "На развилке держитесь правее");
  assert.equal(instruction({ maneuver: { type: "new name", modifier: "straight" }, name: "7th Ave" }).text, "Продолжайте прямо на 7th Ave");
  assert.equal(spoken({ maneuver: { type: "turn", modifier: "left" }, name: "W 42nd St" }, 210), "Через 200 метров поверните налево на W 42nd St");
  assert.equal(spoken({ maneuver: { type: "turn", modifier: "left" }, name: "" }, 1500), "Через 1,5 километра поверните налево");
  assert.equal(spoken({ maneuver: { type: "turn", modifier: "left" }, name: "" }, 10), "Поверните налево");
});

// Маршрут-«уголок»: на восток по 42-й, потом на юг по 5-й авеню
const OSRM = {
  code: "Ok",
  routes: [{
    distance: 900, duration: 300,
    geometry: { coordinates: [[-73.990, 40.756], [-73.981, 40.7545], [-73.983, 40.7500]] },
    legs: [{ steps: [
      { distance: 700, duration: 220, name: "W 42nd St", maneuver: { type: "depart", location: [-73.990, 40.756] } },
      { distance: 200, duration: 80, name: "5th Avenue", maneuver: { type: "turn", modifier: "right", location: [-73.981, 40.7545] } },
      { distance: 0, duration: 0, name: "", maneuver: { type: "arrive", location: [-73.983, 40.75] } },
    ] }],
  }],
};

test("маршрут OSRM: шаги с позицией на линии", () => {
  const [r] = parseRoute(OSRM);
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.steps.map((s) => s.at), [0, 700, 900]);
  assert.equal(r.steps[1].text, "Поверните направо на 5th Avenue");
  assert.deepEqual(parseRoute({ code: "NoRoute" }), []);
  assert.match(routeUrl("foot", [TIMES_SQ, EMPIRE]), /routed-foot\/route\/v1\/driving\/-73\.985500,40\.758000;-73\.985700,40\.748400\?overview=full&geometries=geojson&steps=true&alternatives=true/);
  assert.match(routeUrl("car", [TIMES_SQ, EMPIRE, TIMES_SQ]), /alternatives=false/);
});

test("навигация: где мы на маршруте и сход с него", () => {
  const [r] = parseRoute(OSRM);
  r.distance = lineLength(r.coords);
  r.steps[1].at = distance(r.coords[0], r.coords[1]);
  r.steps[2].at = r.distance;
  const start = progress(r, [-73.9899, 40.7559]);
  assert.equal(start.offRoute, false);
  assert.equal(start.next, 1);                       // впереди — поворот на 5-ю авеню
  assert.ok(start.toStep > 600);
  const near = nearestOnLine(r.coords, [-73.9855, 40.75525]);
  assert.ok(near.dist < 20 && near.index === 0);
  const away = progress(r, [-73.9855, 40.7600]);     // в полукилометре севернее
  assert.equal(away.offRoute, true);
  const end = progress(r, [-73.98301, 40.75005]);
  assert.equal(end.arrived, true);
});

test("поиск и «Рядом»: разбор ответов", () => {
  const ph = parsePhoton({ features: [{ geometry: { coordinates: [-73.9857, 40.7484] },
    properties: { name: "Empire State Building", street: "5th Avenue", housenumber: "350", city: "New York", state: "New York", country: "United States", osm_value: "attraction" } }] });
  assert.deepEqual(ph[0], { name: "Empire State Building", address: "5th Avenue, 350, New York, United States", center: [-73.9857, 40.7484], kind: "attraction", extent: null });
  const rev = parseNominatim({ lat: "40.758", lon: "-73.9855", type: "square", name: "Times Square", address: { road: "7th Avenue", city: "New York", country: "United States" } });
  assert.equal(rev.name, "Times Square");
  assert.deepEqual(rev.center, TIMES_SQ);
  assert.equal(parseNominatim({ error: "Unable to geocode" }), null);
  assert.match(overpassQuery("pharmacy", [-74, 40.7, -73.9, 40.8]), /node\["amenity"="pharmacy"\]\(40\.7,-74,40\.8,-73\.9\)/);
  const op = parseOverpass({ elements: [
    { type: "way", center: { lon: -73.99, lat: 40.75 }, tags: { amenity: "cafe", name: "Далёкое" } },
    { type: "node", lon: -73.9856, lat: 40.7485, tags: { amenity: "cafe", name: "Рядом", opening_hours: "24/7" } },
    { type: "relation", tags: { name: "без центра" } },
  ] }, EMPIRE);
  assert.deepEqual(op.map((x) => x.name), ["Рядом", "Далёкое"]);
  assert.equal(op[0].hours, "24/7");
});

test("голосовые команды карты — как в Python", async () => {
  const { mapIntent } = await import("../../jarvis/webapp/static/core/intents.js");
  assert.deepEqual(mapIntent("открой карту"), { name: "map", args: {} });
  assert.deepEqual(mapIntent("маршрут до таймс-сквер"), { name: "map", args: { route: "таймс-сквер", mode: "car" } });
  assert.deepEqual(mapIntent("как дойти до центрального парка"), { name: "map", args: { route: "центрального парка", mode: "foot" } });
  assert.deepEqual(mapIntent("покажи на карте бруклинский мост"), { name: "map", args: { query: "бруклинский мост" } });
  assert.deepEqual(mapIntent("где я"), { name: "map", args: { locate: true } });
  assert.deepEqual(mapIntent("аптеки рядом"), { name: "map", args: { nearby: "pharmacy" } });
  assert.deepEqual(mapIntent("ближайшее метро рядом"), { name: "map", args: { nearby: "metro" } });
  assert.equal(mapIntent("покажи нью-йорк"), null);              // облёта Нью-Йорка больше нет
  assert.equal(mapIntent("покажи задачи"), null);
});

test("места в хранилище и маршруты /api/places — как в Python", async () => {
  const { LocalStore, Vault } = await import("../../jarvis/webapp/static/core/vault.js");
  const { Places } = await import("../../jarvis/webapp/static/core/places.js");
  const { Jarvis } = await import("../../jarvis/webapp/static/core/jarvis.js");
  const vault = new Vault(new LocalStore("places", {}));
  await vault.load();
  const p = new Places(vault);
  await p.add("Дом", 40.7484, -73.9857, "350 5th Ave", "Дом");
  await p.add("Работа", 40.758, -73.9855, "Times Square", "работа", "офис | 7 этаж");
  assert.deepEqual(p.list()[0], { name: "Дом", lat: 40.7484, lon: -73.9857, address: "350 5th Ave", category: "дом", note: "" });
  assert.equal(p.list()[1].note, "офис / 7 этаж");
  await p.add("дом", 40.7, -74.0);
  assert.equal(p.list().length, 2);
  assert.match(vault.read("Jarvis/Places.md"), /\| дом \| 40\.700000 \| -74\.000000 \|/);
  assert.equal(await p.remove("Работа"), true);
  assert.equal(await p.remove("Работа"), false);
  await assert.rejects(p.add("Луна", 95, 0));
  const j = await new Jarvis({ title: "сэр" }, { store: new LocalStore("places2", {}), fetchImpl: async () => { throw new TypeError("offline"); } }).init();
  const r = await j.request("POST", "/api/places", { name: "Парк", lat: 40.78, lon: -73.96 });
  assert.equal(r.places[0].name, "Парк");
  const reply = await j.handle("маршрут пешком до таймс-сквер");
  assert.deepEqual(reply.data.open_map, { route: "таймс-сквер", mode: "foot" });
});
