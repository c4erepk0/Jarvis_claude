// Сохранённые места для карты: «Jarvis/Places.md» (таблица). Порт jarvis/places.py.
const HEAD = "| Название | Широта | Долгота | Адрес | Категория | Заметка |\n|----------|-------:|--------:|-------|-----------|---------|";
export const TEMPLATE = `---\ntype: places\n---\n# Места\n\nСохранённые места для карты Atom: звёздочка в карточке места или строка здесь. Категория «дом» и «работа» — быстрые маршруты.\n\n${HEAD}\n`;
const NUM = /^-?\d{1,3}(?:[.,]\d+)?$/;
const cell = (s) => String(s ?? "").replace(/\|/g, "/").replace(/\n/g, " ").trim();
const num = (s) => (NUM.test(s.trim()) ? Number(s.trim().replace(",", ".")) : null);
const nameOf = (line) => line.trim().replace(/^\||\|$/g, "").split("|")[0].trim().toLowerCase();

export class Places {
  constructor(vault, path = "Jarvis/Places.md") { this.vault = vault; this.path = path; }

  list() {
    if (!this.vault.exists(this.path)) return [];
    const out = [];
    for (const line of this.vault.read(this.path).split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      const c = line.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
      while (c.length < 6) c.push("");
      const lat = num(c[1]), lon = num(c[2]);
      if (!c[0] || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      out.push({ name: c[0], lat, lon, address: c[3], category: c[4].toLowerCase(), note: c[5] });
    }
    return out;
  }

  async add(name, lat, lon, address = "", category = "", note = "") {
    name = cell(name);
    if (!name) throw new Error("не указано название места");
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("координаты вне диапазона");
    const row = `| ${name} | ${lat.toFixed(6)} | ${lon.toFixed(6)} | ${cell(address)} | ${cell(category).toLowerCase()} | ${cell(note)} |`;
    await this.vault.update(this.path, (cur) => {
      const lines = (cur === undefined ? TEMPLATE : cur).replace(/\n+$/, "").split("\n");
      const same = lines.findIndex((l) => l.trim().startsWith("|") && nameOf(l) === name.toLowerCase());
      if (same >= 0) lines[same] = row;
      else {
        let last = -1;
        lines.forEach((l, i) => { if (l.trim().startsWith("|")) last = i; });
        if (last >= 0) lines.splice(last + 1, 0, row); else lines.push("", ...HEAD.split("\n"), row);
      }
      return lines.join("\n") + "\n";
    }, `Atom: место ${name}`);
    return this.list().find((p) => p.name.toLowerCase() === name.toLowerCase());
  }

  async remove(name) {
    if (!this.vault.exists(this.path)) return false;
    const key = String(name || "").trim().toLowerCase();
    const lines = this.vault.read(this.path).split("\n");
    const keep = lines.filter((l) => !(l.trim().startsWith("|") && nameOf(l) === key));
    if (keep.length === lines.length) return false;
    await this.vault.write(this.path, keep.join("\n").replace(/\n*$/, "\n"), `Atom: убрано место ${name}`);
    return true;
  }
}
