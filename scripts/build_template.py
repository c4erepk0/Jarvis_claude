"""Собирает jarvis/webapp/static/vault-template.json из vault-template/.

Его использует версия для iPhone: демо-режим и «Создать стартовую структуру» в пустом репозитории памяти.
Запуск: python scripts/build_template.py  (CI проверяет, что файл не устарел).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "vault-template"
OUT = ROOT / "jarvis" / "webapp" / "static" / "vault-template.json"


def build() -> str:
    files = {p.relative_to(SRC).as_posix(): p.read_text(encoding="utf-8")
             for p in sorted(SRC.rglob("*")) if p.is_file()}
    return json.dumps(files, ensure_ascii=False, indent=1) + "\n"


if __name__ == "__main__":
    data = build()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != data:
            sys.exit("vault-template.json устарел: запустите python scripts/build_template.py")
        sys.exit(0)
    OUT.write_text(data, encoding="utf-8")
    print(f"Готово: {OUT.relative_to(ROOT)}")
