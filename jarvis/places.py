"""Сохранённые места для карты: `Jarvis/Places.md` — таблица, её можно править в Obsidian.

| Название | Широта | Долгота | Адрес | Категория | Заметка |
|----------|-------:|--------:|-------|-----------|---------|
| Дом | 55.751244 | 37.618423 | Красная площадь, 1 | дом | |

Порт для iPhone — `core/places.js`. Координаты — с точкой, 6 знаков (≈ 10 см).
"""
from __future__ import annotations

import re

from .vault import Vault

HEAD = ("| Название | Широта | Долгота | Адрес | Категория | Заметка |\n"
        "|----------|-------:|--------:|-------|-----------|---------|\n")
TEMPLATE = ("---\ntype: places\n---\n# Места\n\nСохранённые места для карты Atom: звёздочка в карточке места "
            "или строка здесь. Категория «дом» и «работа» — быстрые маршруты.\n\n" + HEAD)
NUM = re.compile(r"^-?\d{1,3}(?:[.,]\d+)?$")


def _cell(s) -> str:
    return str(s if s is not None else "").replace("|", "/").replace("\n", " ").strip()


def _num(s: str) -> float | None:
    s = s.strip()
    return float(s.replace(",", ".")) if NUM.match(s) else None


class Places:
    def __init__(self, vault: Vault, path: str = "Jarvis/Places.md"):
        self.vault = vault
        self.path = path

    def list(self) -> list[dict]:
        if not self.vault.exists(self.path):
            return []
        out = []
        for line in self.vault.read(self.path).splitlines():
            if not line.strip().startswith("|"):
                continue
            c = [x.strip() for x in line.strip().strip("|").split("|")]
            c += [""] * (6 - len(c))
            lat, lon = _num(c[1]), _num(c[2])
            if not c[0] or lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
                continue
            out.append({"name": c[0], "lat": lat, "lon": lon, "address": c[3], "category": c[4].lower(), "note": c[5]})
        return out

    def add(self, name: str, lat: float, lon: float, address: str = "", category: str = "", note: str = "") -> dict:
        name = _cell(name)
        if not name:
            raise ValueError("не указано название места")
        lat, lon = float(lat), float(lon)
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("координаты вне диапазона")
        row = (f"| {name} | {lat:.6f} | {lon:.6f} | {_cell(address)} | {_cell(category).lower()} | {_cell(note)} |")
        text = self.vault.read(self.path) if self.vault.exists(self.path) else TEMPLATE
        lines = text.rstrip("\n").splitlines()
        same = [i for i, ln in enumerate(lines) if ln.strip().startswith("|") and self._name(ln) == name.lower()]
        if same:
            lines[same[0]] = row                       # то же название — обновить место
        else:
            rows = [i for i, ln in enumerate(lines) if ln.strip().startswith("|")]
            if rows:
                lines.insert(rows[-1] + 1, row)
            else:
                lines += ["", *HEAD.strip().splitlines(), row]
        self.vault.write(self.path, "\n".join(lines) + "\n")
        return next(p for p in self.list() if p["name"].lower() == name.lower())

    def remove(self, name: str) -> bool:
        if not self.vault.exists(self.path):
            return False
        lines = self.vault.read(self.path).splitlines()
        keep = [ln for ln in lines if not (ln.strip().startswith("|") and self._name(ln) == name.strip().lower())]
        if len(keep) == len(lines):
            return False
        self.vault.write(self.path, "\n".join(keep) + "\n")
        return True

    @staticmethod
    def _name(line: str) -> str:
        return line.strip().strip("|").split("|")[0].strip().lower()
