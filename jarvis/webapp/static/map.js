// Карта и навигация Atom (MapLibre GL с CDN, без ключей). Возможности как у привычных карт:
//  поиск мест с подсказками (Photon; русские названия мест Нью-Йорка — localAlias), «Что здесь?» (Nominatim),
//  маршруты на машине, пешком и на велосипеде с альтернативами и списком манёвров (OSRM, routing.openstreetmap.de),
//  пошаговая навигация с голосом, ведением камеры и перестроением при сходе с маршрута (и «симуляция» — проехать
//  маршрут без GPS), «Рядом» — кафе, аптеки, метро… (Overpass), сохранённые места (Jarvis/Places.md через /api/places),
//  слои «Карта / Тёмная / Спутник», 3D-здания и наклон, линейка, «поделиться», облёт Нью-Йорка.
// Логика без DOM — geo.js (тест — tests/js/geo.test.mjs).
import { NEARBY, NYC, NYC_TOUR, PROFILES, arrival, bearing, coordsText, distance, formatDistance, formatDuration,
  lineLength, localAlias, overpassQuery, parseCoords, parseNominatim, parseOverpass, parsePhoton, parseRoute, progress,
  routeUrl, shareLink, spoken } from "./geo.js?v=20";

const ML_VER = "4.7.1";
const ML_JS = `https://cdn.jsdelivr.net/npm/maplibre-gl@${ML_VER}/dist/maplibre-gl.js`;
const ML_CSS = `https://cdn.jsdelivr.net/npm/maplibre-gl@${ML_VER}/dist/maplibre-gl.css`;
const PHOTON = "https://photon.komoot.io/api/";
const NOMINATIM = "https://nominatim.openstreetmap.org/reverse";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const OFM = "https://tiles.openfreemap.org/planet";
const STYLES = {
  map: { label: "Карта", url: "https://tiles.openfreemap.org/styles/liberty" },
  dark: { label: "Тёмная", url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" },
  sat: { label: "Спутник", style: {
    version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: { esri: { type: "raster", tileSize: 256, maxzoom: 19, attribution: "© Esri, Maxar, Earthstar Geographics",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] } },
    layers: [{ id: "esri", type: "raster", source: "esri" }] } },
};
const ROUTE_COLORS = ["#ff453a", "#8fa8ff", "#b0a7a4"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let mlLoading = null;
/** MapLibre — UMD-сборка с CDN (одна на страницу) и её стили. */
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (!mlLoading) {
    mlLoading = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = ML_CSS;
      document.head.append(css);
      const s = document.createElement("script");
      s.src = ML_JS; s.async = true;
      s.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error("MapLibre не загрузился")));
      s.onerror = () => { mlLoading = null; reject(new Error("нет связи с CDN карты")); };
      document.head.append(s);
    });
  }
  return mlLoading;
}

export class MapWindow {
  /** root — пустой #mw; api, toast, store — как в app.js; speak(text) — голос Atom (подсказки навигации). */
  constructor(root, { api, toast, store, speak, fetchImpl = (...a) => fetch(...a) }) {
    Object.assign(this, { root, api, toast, store, speak, fetch: fetchImpl });
    this.styleKey = store.get("map.style", "map");
    this.is3d = store.get("map.3d", true);
    this.profile = store.get("map.profile", "car");
    this.places = [];
    this.markers = { places: [], nearby: [], pick: null, me: null, from: null };
    this.route = { from: null, to: null, list: [], active: 0 };
    this.nav = null;
    this.measure = null;
    root.innerHTML = `
      <div class="mw-map" data-el="map"></div>
      <div class="mw-top">
        <form class="mw-search" data-el="search-form" autocomplete="off">
          <span class="mw-ic">⌕</span>
          <input data-el="q" type="search" placeholder="Поиск мест и адресов · «кафе», «Таймс-сквер», «40.75, -73.98»" enterkeyhint="search" aria-label="Поиск на карте">
          <button type="button" class="mw-x hidden" data-act="clear" aria-label="Очистить">✕</button>
          <ul class="mw-suggest hidden" data-el="suggest" role="listbox"></ul>
        </form>
        <button class="btn ghost mw-close" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть карту">✕</button>
      </div>
      <div class="mw-chips" data-el="chips">${Object.entries(NEARBY).map(([k, v]) => `<button class="chip-btn" data-near="${k}">${v.icon} ${v.label}</button>`).join("")}</div>
      <aside class="mw-panel hidden" data-el="panel"></aside>
      <div class="mw-tools">
        <div class="seg mw-layers" data-el="layers">${Object.entries(STYLES).map(([k, v]) => `<button data-style="${k}">${v.label}</button>`).join("")}</div>
        <button class="mw-tool" data-act="3d" title="3D-здания и наклон">3D</button>
        <button class="mw-tool" data-act="compass" title="На север" aria-label="Компас"><span data-el="needle">➤</span></button>
        <button class="mw-tool" data-act="locate" title="Где я" aria-label="Моё местоположение">◎</button>
        <button class="mw-tool" data-act="measure" title="Линейка: нажимайте на карту — посчитаю расстояние" aria-label="Линейка">📏</button>
        <button class="mw-tool" data-act="saved" title="Сохранённые места" aria-label="Сохранённые места">★</button>
        <button class="mw-tool" data-act="tour" title="Облёт Нью-Йорка" aria-label="Нью-Йорк">🗽</button>
      </div>
      <div class="mw-nav hidden" data-el="nav"></div>
      <div class="mw-ctx hidden" data-el="ctx"></div>
      <div class="mw-status hidden" data-el="status"></div>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    root.addEventListener("click", (e) => this.onClick(e));
    this.el("search-form").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(this.sTimer); this.search(this.el("q").value, true); });
    this.el("q").addEventListener("input", () => {
      this.el("q").nextElementSibling.classList.toggle("hidden", !this.el("q").value);
      clearTimeout(this.sTimer);
      this.sTimer = setTimeout(() => this.search(this.el("q").value), 260);
    });
    this.el("q").addEventListener("keydown", (e) => this.suggestKeys(e));
  }

  get isOpen() { return !this.root.classList.contains("hidden"); }

  // ---------- открыть / закрыть ----------
  async show(args = {}) {
    this.root.classList.remove("hidden");
    document.body.classList.add("mw-on");
    if (!this.map) await this.init();
    else this.map.resize();
    this.loadPlaces();
    if (args.tour) this.tour();
    if (args.locate) this.locate();
    if (args.nearby) this.nearby(args.nearby);
    if (args.query) { this.el("q").value = args.query; this.search(args.query, true); }
    if (args.route) {
      const to = await this.geocodeOne(args.route);
      if (to) { this.profile = PROFILES[args.mode] ? args.mode : this.profile; this.directions(to); }
      else this.toast(`Не нашёл «${args.route}» на карте`, "warn");
    }
  }

  close() {
    if (this.nav) this.stopNav();
    this.root.classList.add("hidden");
    document.body.classList.remove("mw-on");
  }

  escape() {
    if (!this.el("ctx").classList.contains("hidden")) { this.hideCtx(); return; }
    if (!this.el("suggest").classList.contains("hidden")) { this.el("suggest").classList.add("hidden"); return; }
    if (this.measure) { this.stopMeasure(); return; }
    if (!this.el("panel").classList.contains("hidden") && !this.nav) { this.closePanel(); return; }
    this.close();
  }

  async init() {
    let ml;
    try { ml = await loadMapLibre(); } catch (e) {
      this.el("map").innerHTML = `<div class="mw-fail"><b>Карта не загрузилась</b><p>${esc(e.message)}. Нужен интернет: карта, поиск и маршруты — бесплатные сервисы OpenStreetMap.</p></div>`;
      throw e;
    }
    this.ml = ml;
    const view = this.store.get("map.view", null) || NYC;
    this.map = new ml.Map({
      container: this.el("map"), style: this.styleOf(this.styleKey), center: view.center, zoom: view.zoom,
      pitch: this.is3d ? view.pitch ?? NYC.pitch : 0, bearing: view.bearing ?? 0, maxPitch: 75, attributionControl: { compact: true },
      cooperativeGestures: false, hash: false,
    });
    this.map.addControl(new ml.ScaleControl({ unit: "metric" }), "bottom-left");
    this.map.on("style.load", () => this.decorate());
    this.map.on("moveend", () => {
      const c = this.map.getCenter();
      this.store.set("map.view", { center: [c.lng, c.lat], zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() });
    });
    this.map.on("rotate", () => { this.el("needle").style.transform = `rotate(${-90 - this.map.getBearing()}deg)`; });
    this.map.on("click", (e) => this.onMapClick(e));
    this.map.on("contextmenu", (e) => this.showCtx(e));
    this.map.on("dragstart", () => { if (this.nav) this.nav.follow = false; this.hideCtx(); });
    this.markLayers();
  }

  styleOf(key) { const s = STYLES[key] || STYLES.map; return s.url || s.style; }

  setStyle(key) {
    if (!STYLES[key] || key === this.styleKey) return;
    this.styleKey = key;
    this.store.set("map.style", key);
    this.map.setStyle(this.styleOf(key));
    this.markLayers();
  }

  markLayers() {
    this.root.querySelectorAll("[data-style]").forEach((b) => b.classList.toggle("on", b.dataset.style === this.styleKey));
    this.root.querySelector('[data-act="3d"]').classList.toggle("on", this.is3d);
  }

  /** После смены стиля — заново: 3D-здания, маршрут, линейка (метки — DOM, они остаются сами). */
  decorate() {
    const m = this.map;
    const own3d = m.getLayer("building-3d");
    if (!own3d && this.styleKey !== "sat") {
      try {
        if (!m.getSource("ofm")) m.addSource("ofm", { type: "vector", url: OFM });
        m.addLayer({ id: "atom-3d", type: "fill-extrusion", source: "ofm", "source-layer": "building", minzoom: 14,
          paint: { "fill-extrusion-color": this.styleKey === "dark" ? "#2b2627" : "#d9d2cf",
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 12],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0], "fill-extrusion-opacity": 0.82 } });
      } catch { /* стиль без поддержки — без 3D */ }
    }
    this.apply3d();
    for (const id of ["route", "measure"]) {
      if (!m.getSource(id)) m.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!m.getLayer("route-casing")) {
      m.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#1b0b0a", "line-width": ["case", ["get", "active"], 11, 8], "line-opacity": 0.55 } });
      m.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round",
        "line-sort-key": ["case", ["get", "active"], 1, 0] },
      paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "active"], 7, 5], "line-opacity": ["case", ["get", "active"], 1, 0.7] } });
      m.addLayer({ id: "measure-line", type: "line", source: "measure", filter: ["==", "$type", "LineString"],
        paint: { "line-color": "#ffb347", "line-width": 3, "line-dasharray": [2, 1.5] } });
      m.addLayer({ id: "measure-pts", type: "circle", source: "measure", filter: ["==", "$type", "Point"],
        paint: { "circle-radius": 5, "circle-color": "#ffb347", "circle-stroke-color": "#1b0b0a", "circle-stroke-width": 2 } });
      m.on("click", "route-line", (e) => {
        const i = e.features?.[0]?.properties?.index;
        if (Number.isInteger(i) && i !== this.route.active && !this.nav) { this.route.active = i; this.drawRoutes(); this.renderRoute(); }
      });
    }
    this.drawRoutes();
    this.drawMeasure();
  }

  apply3d() {
    for (const id of ["building-3d", "atom-3d"]) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", this.is3d ? "visible" : "none");
  }

  toggle3d() {
    this.is3d = !this.is3d;
    this.store.set("map.3d", this.is3d);
    this.apply3d();
    this.map.easeTo({ pitch: this.is3d ? 55 : 0, duration: 600 });
    this.markLayers();
  }

  // ---------- поиск ----------
  async search(q, pick = false) {
    q = String(q || "").trim();
    const box = this.el("suggest");
    if (!q) { box.classList.add("hidden"); return; }
    const coords = parseCoords(q);
    if (coords) { this.pick({ name: coordsText(coords), address: "Координаты", center: coords }); box.classList.add("hidden"); return; }
    const mine = this.places.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
      .map((p) => ({ name: p.name, address: p.address || "сохранённое место", center: [p.lon, p.lat], saved: true }));
    let found = [];
    try { found = await this.geocode(q); } catch { if (!mine.length) this.status("Поиск недоступен — нет связи с сервисом", true); }
    if (this.el("q").value.trim() !== q && !pick) return;          // пока ждали — ввели другое
    const dup = (r) => mine.some((m) => m.name === r.name && distance(m.center, r.center) < 60);   // сохранённое — не дублировать
    this.results = [...mine, ...found.filter((r) => !dup(r))].slice(0, 8);
    this.sel = pick ? 0 : -1;
    if (pick && this.results.length) { this.pick(this.results[0], { fit: true }); box.classList.add("hidden"); this.picked = q; return; }
    if (this.picked === q) return;                                 // уже выбрали по Enter — подсказки не нужны
    box.innerHTML = this.results.map((r, i) => `<li role="option" data-i="${i}"><span class="mw-ic">${r.saved ? "★" : "⌖"}</span>
      <span><b>${esc(r.name)}</b><small>${esc(r.address)}</small></span>${this.here ? `<em>${formatDistance(distance(this.here, r.center))}</em>` : ""}</li>`).join("")
      || `<li class="empty">Ничего не нашлось</li>`;
    box.classList.remove("hidden");
  }

  async geocode(q, limit = 7) {
    const c = this.map.getCenter();
    const u = new URL(PHOTON);
    u.searchParams.set("q", localAlias(q));
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("lat", c.lat.toFixed(4)); u.searchParams.set("lon", c.lng.toFixed(4));
    const r = await this.fetch(u.toString());
    if (!r.ok) throw new Error(`поиск: HTTP ${r.status}`);
    return parsePhoton(await r.json());
  }

  async geocodeOne(q) {
    const saved = this.places.find((p) => p.name.toLowerCase() === String(q).toLowerCase());
    if (saved) return { name: saved.name, address: saved.address, center: [saved.lon, saved.lat], saved: true };
    const c = parseCoords(q);
    if (c) return { name: coordsText(c), address: "", center: c };
    try { return (await this.geocode(q, 1))[0] || null; } catch { return null; }
  }

  suggestKeys(e) {
    const box = this.el("suggest");
    if (box.classList.contains("hidden") || !this.results?.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.sel = (this.sel + (e.key === "ArrowDown" ? 1 : -1) + this.results.length) % this.results.length;
      box.querySelectorAll("li").forEach((li, i) => li.classList.toggle("on", i === this.sel));
    } else if (e.key === "Enter" && this.sel >= 0) {
      e.preventDefault();
      this.pick(this.results[this.sel], { fit: true });
      box.classList.add("hidden");
    }
  }

  async reverse(center) {
    const u = new URL(NOMINATIM);
    u.searchParams.set("format", "jsonv2");
    u.searchParams.set("lat", center[1].toFixed(6)); u.searchParams.set("lon", center[0].toFixed(6));
    u.searchParams.set("accept-language", "ru");
    u.searchParams.set("zoom", "18");
    try {
      const r = await this.fetch(u.toString());
      return r.ok ? parseNominatim(await r.json()) : null;
    } catch { return null; }
  }

  // ---------- карточка места ----------
  pick(place, { fit = false } = {}) {
    this.hideCtx();
    this.current = place;
    if (this.markers.pick) this.markers.pick.remove();
    const el = document.createElement("div");
    el.className = "mw-pin";
    this.markers.pick = new this.ml.Marker({ element: el, anchor: "bottom" }).setLngLat(place.center).addTo(this.map);
    if (fit) this.map.flyTo({ center: place.center, zoom: Math.max(this.map.getZoom(), 16), speed: 1.4, essential: true });
    const saved = this.places.some((p) => p.name === place.name && Math.abs(p.lon - place.center[0]) < 1e-5);
    const meta = [place.hours && `🕒 ${esc(place.hours)}`, place.phone && `☎ <a href="tel:${esc(place.phone)}">${esc(place.phone)}</a>`,
      place.site && `<a href="${esc(place.site)}" target="_blank" rel="noopener">сайт ↗</a>`].filter(Boolean).join(" · ");
    this.panel(`<div class="mw-card">
      <h3>${esc(place.name)}</h3>
      <p class="muted">${esc(place.address || coordsText(place.center))}${this.here ? ` · ${formatDistance(distance(this.here, place.center))} от вас` : ""}</p>
      ${meta ? `<p class="mw-meta">${meta}</p>` : ""}
      <div class="mw-acts">
        <button class="btn primary" data-act="route-to">↱ Маршрут</button>
        <button class="btn ghost ${saved ? "on" : ""}" data-act="save">${saved ? "★ Сохранено" : "☆ Сохранить"}</button>
        <button class="btn ghost" data-act="share">⤴ Поделиться</button>
        <button class="btn ghost" data-act="near-here">Рядом</button>
      </div>
      <p class="mw-coords" title="Нажмите, чтобы скопировать" data-act="copy">${coordsText(place.center)}</p></div>`);
  }

  // ---------- маршруты ----------
  async directions(to, from = null) {
    this.route.to = to;
    this.route.from = from || this.route.from;
    if (!this.route.from) {
      const me = await this.locate({ fly: false, quiet: true });
      this.route.from = me ? { name: "Моё местоположение", center: me, me: true } : null;
    }
    if (!this.route.from) {
      this.route.from = { name: "Центр карты", center: [this.map.getCenter().lng, this.map.getCenter().lat] };
      this.toast("Геолокация недоступна — маршрут от центра карты. Точку «Откуда» можно выбрать долгим нажатием.", "info");
    }
    await this.buildRoute();
  }

  async buildRoute({ quiet = false } = {}) {
    const { from, to } = this.route;
    if (!from || !to) return;
    if (!quiet) this.panel(`<div class="mw-card"><p class="muted">Строю маршрут…</p></div>`);
    let list = [];
    try {
      const r = await this.fetch(routeUrl(this.profile, [from.center, to.center]));
      list = parseRoute(await r.json());
    } catch { /* ниже — сообщение */ }
    if (!list.length) {
      this.route.list = [];
      this.drawRoutes();
      if (!quiet) this.panel(`<div class="mw-card"><h3>Маршрут не найден</h3><p class="muted">Сервис маршрутов недоступен или между точками нет дороги.</p>
        <div class="mw-acts"><button class="btn ghost" data-act="close-panel">Закрыть</button></div></div>`);
      return false;
    }
    this.route.list = list;
    this.route.active = 0;
    this.drawRoutes();
    if (this.markers.from) this.markers.from.remove();
    if (!from.me) {
      const el = document.createElement("div"); el.className = "mw-dot from";
      this.markers.from = new this.ml.Marker({ element: el }).setLngLat(from.center).addTo(this.map);
    }
    if (!quiet) {
      const b = list[0].coords.reduce((bb, c) => bb.extend(c), new this.ml.LngLatBounds(list[0].coords[0], list[0].coords[0]));
      this.map.fitBounds(b, { padding: this.fitPadding(), duration: 900, pitch: this.is3d ? 40 : 0 });
      this.renderRoute();
    }
    return true;
  }

  fitPadding() {
    const narrow = innerWidth < 760;
    return narrow ? { top: 120, bottom: Math.round(innerHeight * 0.45), left: 30, right: 30 } : { top: 110, bottom: 60, left: 420, right: 80 };
  }

  drawRoutes() {
    const src = this.map?.getSource("route");
    if (!src) return;
    src.setData({ type: "FeatureCollection", features: this.route.list.map((r, i) => ({ type: "Feature",
      properties: { index: i, active: i === this.route.active, color: i === this.route.active ? ROUTE_COLORS[0] : ROUTE_COLORS[2] },
      geometry: { type: "LineString", coordinates: r.coords } })) });
  }

  renderRoute() {
    const { from, to, list, active } = this.route, r = list[active];
    if (!r) return;
    this.panel(`<div class="mw-route">
      <div class="mw-ends"><div><small>Откуда</small><b>${esc(from.name)}</b></div>
        <button class="mw-tool" data-act="swap" title="Поменять местами">⇅</button><div><small>Куда</small><b>${esc(to.name)}</b></div></div>
      <div class="seg mw-modes">${Object.entries(PROFILES).map(([k, p]) => `<button data-profile="${k}" class="${k === this.profile ? "on" : ""}">${p.icon} ${p.label}</button>`).join("")}</div>
      <ul class="mw-alts">${list.map((x, i) => `<li class="${i === active ? "on" : ""}" data-alt="${i}"><b>${formatDuration(x.duration)}</b>
        <span>${formatDistance(x.distance)} · прибытие ${arrival(x.duration)}</span>${i === 0 ? "<em>быстрее</em>" : ""}</li>`).join("")}</ul>
      <div class="mw-acts"><button class="btn primary" data-act="nav-start">▶ Поехали</button>
        <button class="btn ghost" data-act="nav-sim" title="Проехать маршрут без GPS — посмотреть подсказки">Симуляция</button>
        <button class="btn ghost" data-act="route-clear">Сбросить</button></div>
      <ol class="mw-steps">${r.steps.map((s, i) => `<li data-step="${i}"><span class="mw-man">${s.icon}</span><span>${esc(s.text)}</span><em>${s.distance ? formatDistance(s.distance) : ""}</em></li>`).join("")}</ol>
    </div>`);
  }

  clearRoute() {
    this.route = { from: null, to: null, list: [], active: 0 };
    this.markers.from?.remove(); this.markers.from = null;
    this.drawRoutes();
    this.closePanel();
  }

  // ---------- навигация ----------
  startNav(simulate = false) {
    const r = this.route.list[this.route.active];
    if (!r) return;
    this.route.list = [r]; this.route.active = 0; this.drawRoutes();
    this.nav = { route: r, follow: true, spoken: new Set(), off: 0, simulate, started: Date.now() };
    this.closePanel();
    this.root.classList.add("navigating");
    this.el("nav").classList.remove("hidden");
    this.say(`${r.steps[0]?.text || "Поехали"}. Ехать ${formatDuration(r.duration)}.`);
    if (simulate) this.simulate();
    else if (navigator.geolocation) {
      this.nav.watch = navigator.geolocation.watchPosition((p) => this.onFix([p.coords.longitude, p.coords.latitude], p.coords.heading),
        (e) => { this.toast(`GPS: ${e.message}`, "warn"); }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    } else { this.toast("Нет геолокации — запускаю симуляцию", "warn"); this.nav.simulate = true; this.simulate(); }
    this.renderNav(progress(r, r.coords[0]));
  }

  simulate() {
    const r = this.nav.route, speed = { car: 14, bike: 5, foot: 1.6 }[this.profile] || 10;   // м/с
    const total = lineLength(r.coords), t0 = performance.now(), mult = 6;                   // ускорено в 6 раз
    const step = (now) => {
      if (!this.nav?.simulate) return;
      const along = Math.min(total, ((now - t0) / 1000) * speed * mult);
      let walked = 0, pos = r.coords[r.coords.length - 1], head = 0;
      for (let i = 0; i < r.coords.length - 1; i++) {
        const seg = distance(r.coords[i], r.coords[i + 1]);
        if (walked + seg >= along) {
          const k = seg ? (along - walked) / seg : 0;
          pos = [r.coords[i][0] + (r.coords[i + 1][0] - r.coords[i][0]) * k, r.coords[i][1] + (r.coords[i + 1][1] - r.coords[i][1]) * k];
          head = bearing(r.coords[i], r.coords[i + 1]);
          break;
        }
        walked += seg;
      }
      this.onFix(pos, head);
      if (this.nav && along < total) this.nav.raf = requestAnimationFrame(step);
    };
    this.nav.raf = requestAnimationFrame(step);
  }

  async onFix(pos, heading) {
    if (!this.nav) return;
    this.here = pos;
    this.showMe(pos);
    const n = this.nav, p = progress(n.route, pos);
    if (p.arrived) { this.say("Вы прибыли."); this.toast("Вы на месте ⚑", "ok"); this.stopNav(); return; }
    if (p.offRoute && !n.simulate) {
      if (++n.off >= 2 && !n.rerouting) {               // два замера подряд вне маршрута — перестроить
        n.rerouting = true;
        this.say("Перестраиваю маршрут");
        this.route.from = { name: "Моё местоположение", center: pos, me: true };
        if (await this.buildRoute({ quiet: true })) { n.route = this.route.list[0]; n.spoken.clear(); }
        n.rerouting = false; n.off = 0;
      }
    } else n.off = 0;
    // голос: заранее и перед самым манёвром
    const marks = this.profile === "car" ? [600, 200, 40] : [150, 40];
    for (const mark of marks) {
      const key = `${p.next}:${mark}`;
      if (p.toStep <= mark && !n.spoken.has(key) && (mark === marks[marks.length - 1] || p.toStep > marks[marks.indexOf(mark) + 1])) {
        marks.filter((x) => x >= mark).forEach((x) => n.spoken.add(`${p.next}:${x}`));
        this.say(spoken(p.step.maneuver ? p.step : { maneuver: { type: "turn" } }, p.toStep));
        break;
      }
    }
    if (n.follow) {
      const head = Number.isFinite(heading) && heading !== null ? heading
        : bearing(pos, n.route.coords[Math.min(n.route.coords.length - 1, (progressIndex(n.route, p.along)) + 1)]);
      this.map.easeTo({ center: pos, bearing: head, pitch: 60, zoom: this.profile === "foot" ? 18 : 17, duration: n.simulate ? 120 : 800,
        padding: { top: Math.round(innerHeight * 0.38), bottom: 0, left: 0, right: 0 } });      // «я» — ниже центра, дорога впереди видна
    }
    this.renderNav(p);
  }

  renderNav(p) {
    const n = this.nav;
    if (!n) return;
    this.el("nav").innerHTML = `<div class="mw-nav-next"><span class="mw-man big">${p.step?.icon || "↑"}</span>
        <div><b>${formatDistance(p.toStep)}</b><span>${esc(p.step?.text || "")}</span></div></div>
      <div class="mw-nav-foot"><div><b>${formatDuration(p.timeLeft)}</b><small>${formatDistance(p.left)} · ${arrival(p.timeLeft)}</small></div>
        ${n.follow ? "" : `<button class="btn ghost" data-act="nav-follow">◎ Вести</button>`}
        <button class="btn ghost" data-act="nav-mute">${this.store.get("map.mute", false) ? "🔇" : "🔊"}</button>
        <button class="btn danger" data-act="nav-stop">Завершить</button></div>`;
  }

  stopNav() {
    if (!this.nav) return;
    if (this.nav.watch !== undefined) navigator.geolocation.clearWatch(this.nav.watch);
    cancelAnimationFrame(this.nav.raf);
    this.nav = null;
    this.root.classList.remove("navigating");
    this.el("nav").classList.add("hidden");
    this.map.easeTo({ pitch: this.is3d ? 50 : 0, bearing: 0, duration: 700, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    this.renderRoute();
  }

  say(text) { if (!this.store.get("map.mute", false)) this.speak?.(text); }

  // ---------- где я ----------
  locate({ fly = true, quiet = false } = {}) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { if (!quiet) this.toast("Геолокация недоступна", "warn"); resolve(null); return; }
      navigator.geolocation.getCurrentPosition((p) => {
        const pos = [p.coords.longitude, p.coords.latitude];
        this.here = pos;
        this.showMe(pos, p.coords.accuracy);
        if (fly) this.map.flyTo({ center: pos, zoom: 16.5, speed: 1.6 });
        resolve(pos);
      }, (e) => { if (!quiet) this.toast(`Не удалось определить место: ${e.message}`, "warn"); resolve(null); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
    });
  }

  showMe(pos) {
    if (!this.markers.me) {
      const el = document.createElement("div"); el.className = "mw-me";
      this.markers.me = new this.ml.Marker({ element: el }).setLngLat(pos).addTo(this.map);
    } else this.markers.me.setLngLat(pos);
  }

  // ---------- рядом ----------
  async nearby(kind, center = null) {
    if (!NEARBY[kind]) return;
    this.root.querySelectorAll("[data-near]").forEach((b) => b.classList.toggle("on", b.dataset.near === kind));
    if (center) this.map.jumpTo({ center, zoom: Math.max(this.map.getZoom(), 15.5) });
    else if (this.map.getZoom() < 14) this.map.jumpTo({ zoom: 15 });
    const b = this.map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const from = center || this.here || [this.map.getCenter().lng, this.map.getCenter().lat];
    this.panel(`<div class="mw-card"><p class="muted">Ищу: ${NEARBY[kind].label.toLowerCase()}…</p></div>`);
    let items = [];
    try {
      const r = await this.fetch(OVERPASS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(overpassQuery(kind, bbox))}` });
      items = parseOverpass(await r.json(), from);
    } catch { this.panel(`<div class="mw-card"><h3>${NEARBY[kind].label}</h3><p class="muted">Сервис «Рядом» не ответил. Попробуйте ещё раз.</p></div>`); return; }
    this.nearbyItems = items;
    this.markers.nearby.forEach((m) => m.remove());
    this.markers.nearby = items.slice(0, 60).map((it, i) => {
      const el = document.createElement("button");
      el.className = "mw-poi"; el.textContent = NEARBY[kind].icon; el.title = it.name; el.dataset.poi = i;
      return new this.ml.Marker({ element: el }).setLngLat(it.center).addTo(this.map);
    });
    this.panel(`<div class="mw-list"><h3>${NEARBY[kind].icon} ${NEARBY[kind].label} <small class="muted">· ${items.length}</small></h3>
      ${items.length ? `<ul>${items.slice(0, 40).map((it, i) => `<li data-poi="${i}"><b>${esc(it.name)}</b>
        <small>${esc(it.address || it.kind)}${it.hours ? ` · 🕒 ${esc(it.hours)}` : ""}</small><em>${formatDistance(it.dist)}</em></li>`).join("")}</ul>`
        : `<p class="muted">В этой части карты ничего не нашлось — отдалите карту.</p>`}</div>`);
  }

  clearNearby() { this.clearNearbyMarkers(); this.closePanel(); }

  // ---------- сохранённые места ----------
  async loadPlaces() {
    try { this.places = (await this.api("/api/places")).places || []; } catch { this.places = []; }
    if (!this.map) return;
    this.markers.places.forEach((m) => m.remove());
    this.markers.places = this.places.map((p, i) => {
      const el = document.createElement("button");
      el.className = `mw-star ${p.category === "дом" ? "home" : p.category === "работа" ? "work" : ""}`;
      el.textContent = p.category === "дом" ? "⌂" : p.category === "работа" ? "◼" : "★";
      el.title = p.name; el.dataset.place = i;
      return new this.ml.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(this.map);
    });
  }

  renderPlaces() {
    const quick = ["дом", "работа"].map((c) => this.places.find((p) => p.category === c)).filter(Boolean);
    this.panel(`<div class="mw-list"><h3>★ Мои места <small class="muted">· ${this.places.length}</small></h3>
      ${quick.length ? `<div class="mw-acts">${quick.map((p) => `<button class="btn ghost" data-go-place="${esc(p.name)}">${p.category === "дом" ? "⌂ Домой" : "◼ На работу"}</button>`).join("")}</div>` : ""}
      ${this.places.length ? `<ul>${this.places.map((p, i) => `<li data-place="${i}"><b>${esc(p.name)}</b><small>${esc(p.address || coordsText([p.lon, p.lat]))}${p.category ? ` · ${esc(p.category)}` : ""}</small>
        <button class="h-btn" data-del-place="${esc(p.name)}" title="Удалить">✕</button></li>`).join("")}</ul>`
        : `<p class="muted">Найдите место и нажмите «☆ Сохранить». Места живут в заметке <code>Jarvis/Places.md</code>.</p>`}</div>`);
  }

  async savePlace(place) {
    const name = place.name || coordsText(place.center);
    const category = /^(дом|home)$/i.test(name) ? "дом" : /^(работа|офис|work)$/i.test(name) ? "работа" : "";
    try {
      await this.api("/api/places", { method: "POST", body: { name, lat: place.center[1], lon: place.center[0], address: place.address || "", category } });
      this.toast(`«${name}» — в моих местах`, "ok");
      await this.loadPlaces();
      this.pick(place);
    } catch (e) { this.toast(e.message, "error"); }
  }

  // ---------- линейка ----------
  startMeasure(from = null) {
    this.measure = { pts: from ? [from] : [] };
    this.root.classList.add("measuring");
    this.drawMeasure();
    this.status("Линейка: нажимайте на карту. Esc — закончить.");
  }
  stopMeasure() {
    this.measure = null;
    this.root.classList.remove("measuring");
    this.drawMeasure();
    this.status("");
  }
  drawMeasure() {
    const src = this.map?.getSource("measure");
    if (!src) return;
    const pts = this.measure?.pts || [];
    src.setData({ type: "FeatureCollection", features: [
      ...(pts.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } }] : []),
      ...pts.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } })),
    ] });
    if (this.measure && pts.length > 1) this.status(`Линейка: ${formatDistance(lineLength(pts))} · точек ${pts.length}. Esc — закончить.`);
  }

  // ---------- облёт Нью-Йорка ----------
  async tour() {
    if (this.touring) { this.touring = false; return; }
    this.touring = true;
    if (!this.is3d) this.toggle3d();
    this.status("Облёт Нью-Йорка · нажмите 🗽 ещё раз, чтобы остановить");
    for (const stop of NYC_TOUR) {
      if (!this.touring || !this.isOpen) break;
      this.status(`🗽 ${stop.name}`);
      this.map.flyTo({ ...stop, duration: 5200, curve: 1.6, essential: true });
      await new Promise((r) => setTimeout(r, 6400));
      if (!this.touring) break;
      this.map.easeTo({ bearing: stop.bearing + 50, duration: 3500, easing: (t) => t });
      await new Promise((r) => setTimeout(r, 3600));
    }
    this.touring = false;
    this.status("");
  }

  // ---------- контекстное меню (правая кнопка, долгое нажатие) ----------
  showCtx(e) {
    const c = [e.lngLat.lng, e.lngLat.lat];
    this.ctxAt = c;
    const box = this.el("ctx");
    box.innerHTML = `<button data-ctx="what">Что здесь?</button><button data-ctx="to">Маршрут сюда</button>
      <button data-ctx="from">Маршрут отсюда</button><button data-ctx="save">Сохранить место</button>
      <button data-ctx="measure">Измерить отсюда</button><button data-ctx="copy">${coordsText(c)}</button>`;
    box.style.left = `${Math.min(e.point.x, innerWidth - 200)}px`;
    box.style.top = `${Math.min(e.point.y, innerHeight - 240)}px`;
    box.classList.remove("hidden");
  }
  hideCtx() { this.el("ctx").classList.add("hidden"); }

  async ctx(act) {
    const c = this.ctxAt;
    this.hideCtx();
    if (act === "copy") { this.copy(coordsText(c)); return; }
    if (act === "measure") { this.startMeasure(c); return; }
    const place = (await this.reverse(c)) || { name: "Точка на карте", address: coordsText(c), center: c };
    place.center = c;
    if (act === "what") this.pick(place);
    if (act === "to") this.directions(place);
    if (act === "from") {
      this.route.from = place;
      if (this.route.to) this.buildRoute(); else { this.pick(place); this.toast("Откуда — задано. Теперь выберите «Куда».", "info"); }
    }
    if (act === "save") this.savePlace(place);
  }

  // ---------- клики ----------
  onMapClick(e) {
    this.hideCtx();
    this.el("suggest").classList.add("hidden");
    if (this.measure) { this.measure.pts.push([e.lngLat.lng, e.lngLat.lat]); this.drawMeasure(); return; }
    const hits = this.map.queryRenderedFeatures(e.point).filter((f) => f.properties?.name && f.layer.type === "symbol");
    if (hits.length) {
      const f = hits[0];
      const center = f.geometry.type === "Point" ? f.geometry.coordinates : [e.lngLat.lng, e.lngLat.lat];
      this.pick({ name: f.properties["name:ru"] || f.properties.name, address: f.properties.class || f.properties.subclass || "", center });
    }
  }

  async onClick(e) {
    const t = e.target;
    const style = t.closest("[data-style]");
    if (style) { this.setStyle(style.dataset.style); return; }
    const near = t.closest("[data-near]");
    if (near) { if (near.classList.contains("on")) this.clearNearby(); else this.nearby(near.dataset.near); return; }
    const sug = t.closest(".mw-suggest li[data-i]");
    if (sug) { this.pick(this.results[+sug.dataset.i], { fit: true }); this.el("suggest").classList.add("hidden"); return; }
    const poi = t.closest("[data-poi]");
    if (poi) { const it = this.nearbyItems[+poi.dataset.poi]; this.pick(it, { fit: true }); return; }
    const del = t.closest("[data-del-place]");
    if (del) {
      e.stopPropagation();
      try { await this.api("/api/places", { method: "POST", body: { action: "remove", name: del.dataset.delPlace } }); await this.loadPlaces(); this.renderPlaces(); }
      catch (err) { this.toast(err.message, "error"); }
      return;
    }
    const go = t.closest("[data-go-place]");
    if (go) { const p = this.places.find((x) => x.name === go.dataset.goPlace); if (p) this.directions({ name: p.name, address: p.address, center: [p.lon, p.lat] }); return; }
    const pl = t.closest("[data-place]");
    if (pl) { const p = this.places[+pl.dataset.place]; this.pick({ name: p.name, address: p.address, center: [p.lon, p.lat] }, { fit: true }); return; }
    const prof = t.closest("[data-profile]");
    if (prof) { this.profile = prof.dataset.profile; this.store.set("map.profile", this.profile); this.buildRoute(); return; }
    const alt = t.closest("[data-alt]");
    if (alt) { this.route.active = +alt.dataset.alt; this.drawRoutes(); this.renderRoute(); return; }
    const stepEl = t.closest("[data-step]");
    if (stepEl) { const s = this.route.list[this.route.active]?.steps[+stepEl.dataset.step]; if (s?.location) this.map.flyTo({ center: s.location, zoom: 17.5 }); return; }
    const c = t.closest("[data-ctx]");
    if (c) { this.ctx(c.dataset.ctx); return; }
    const b = t.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "close") this.close();
    else if (act === "clear") { this.el("q").value = ""; b.classList.add("hidden"); this.el("suggest").classList.add("hidden"); this.el("q").focus(); }
    else if (act === "3d") this.toggle3d();
    else if (act === "compass") this.map.easeTo({ bearing: 0, pitch: this.is3d ? 50 : 0, duration: 600 });
    else if (act === "locate") this.locate();
    else if (act === "measure") { if (this.measure) this.stopMeasure(); else this.startMeasure(); }
    else if (act === "saved") { await this.loadPlaces(); this.renderPlaces(); }
    else if (act === "tour") this.tour();
    else if (act === "route-to") this.directions(this.current);
    else if (act === "save") this.savePlace(this.current);
    else if (act === "share") this.share(this.current);
    else if (act === "copy") this.copy(coordsText(this.current.center));
    else if (act === "near-here") this.nearby("cafe", this.current.center);
    else if (act === "swap") { [this.route.from, this.route.to] = [this.route.to, this.route.from]; this.buildRoute(); }
    else if (act === "route-clear") this.clearRoute();
    else if (act === "close-panel") this.closePanel();
    else if (act === "nav-start") this.startNav(false);
    else if (act === "nav-sim") this.startNav(true);
    else if (act === "nav-stop") this.stopNav();
    else if (act === "nav-follow" && this.nav) { this.nav.follow = true; }
    else if (act === "nav-mute") { this.store.set("map.mute", !this.store.get("map.mute", false)); b.textContent = this.store.get("map.mute", false) ? "🔇" : "🔊"; }
  }

  async share(place) {
    const url = shareLink(place.center, this.map.getZoom());
    if (navigator.share) { try { await navigator.share({ title: place.name, text: place.address || place.name, url }); return; } catch { /* отменили */ } }
    this.copy(url, "Ссылка скопирована");
  }

  async copy(text, ok = "Скопировано") {
    try { await navigator.clipboard.writeText(text); this.toast(ok, "ok"); } catch { this.toast(text, "info"); }
  }

  panel(html) { const p = this.el("panel"); p.innerHTML = `<button class="h-btn mw-panel-x" data-act="close-panel" aria-label="Закрыть">✕</button>${html}`; p.classList.remove("hidden"); }
  closePanel() {
    this.el("panel").classList.add("hidden");
    this.markers.pick?.remove(); this.markers.pick = null;
    if (this.markers.nearby.length && !this.nav) this.clearNearbyMarkers();
  }
  clearNearbyMarkers() {
    this.markers.nearby.forEach((m) => m.remove());
    this.markers.nearby = [];
    this.root.querySelectorAll("[data-near]").forEach((b) => b.classList.remove("on"));
  }

  status(text, warn = false) {
    const s = this.el("status");
    s.textContent = text;
    s.classList.toggle("hidden", !text);
    s.classList.toggle("warn", warn);
    if (warn) setTimeout(() => s.classList.add("hidden"), 4000);
  }
}

/** Номер точки маршрута, ближайшей к пройденному пути along (для направления камеры). */
function progressIndex(route, along) {
  let walked = 0;
  for (let i = 0; i < route.coords.length - 1; i++) {
    walked += distance(route.coords[i], route.coords[i + 1]);
    if (walked >= along) return i;
  }
  return route.coords.length - 1;
}
