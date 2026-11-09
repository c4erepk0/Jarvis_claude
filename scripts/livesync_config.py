"""Собирает конфиг моста livesync-bridge (sync/livesync/config.json) из .env.

Мост держит папку хранилища Jarvis и базу CouchDB плагина Self-hosted LiveSync в синхроне
в обе стороны: правка на iPhone → CouchDB → папка → Jarvis, и обратно.
"""
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


def build(env: dict) -> dict:
    password = env.get("COUCHDB_PASSWORD", "").strip()
    if not password:
        raise SystemExit("Задайте COUCHDB_PASSWORD в .env")
    passphrase = env.get("LIVESYNC_PASSPHRASE", "").strip()
    obfuscate = env.get("LIVESYNC_OBFUSCATE", "0").strip().lower() in ("1", "true", "yes")
    return {
        "peers": [
            {
                "type": "couchdb",
                "name": "obsidian-livesync",
                "group": "vault",
                "url": env.get("LIVESYNC_COUCHDB_URL", "http://couchdb:5984"),
                "database": env.get("LIVESYNC_DB", "jarvis"),
                "username": env.get("COUCHDB_USER", "jarvis"),
                "password": password,
                "passphrase": passphrase,
                "obfuscatePassphrase": passphrase if obfuscate else "",
                "baseDir": "",
                "useRemoteTweaks": True,
            },
            {
                "type": "storage",
                "name": "jarvis-vault",
                "group": "vault",
                "baseDir": "./data/vault/",
                "scanOfflineChanges": True,
                "useChokidar": True,
                "ignore": ["**/.git/**", "**/.obsidian/**", "**/.trash/**", "**/.jarvis-*"],
            },
        ]
    }


def main() -> None:
    load_dotenv(ROOT / ".env")
    out = ROOT / "sync" / "livesync" / "config.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(build(dict(os.environ)), ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        out.chmod(0o600)
    except OSError:
        pass
    print(f"Готово: {out.relative_to(ROOT)}", file=sys.stderr)


if __name__ == "__main__":
    main()
