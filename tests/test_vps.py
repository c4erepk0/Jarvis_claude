"""Установка на VPS (scripts/vps.sh): адрес sslip.io, правка .env, служба systemd и сайт Caddy."""
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "vps.sh"


def vps(*args: str, **env: str) -> str:
    out = subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, timeout=30,
                         env={**os.environ, **env})
    assert out.returncode == 0, out.stderr
    return out.stdout


def test_sslip_domain():
    assert vps("_sslip", "203.0.113.7").strip() == "203-0-113-7.sslip.io"


def test_set_env_replaces_and_keeps_values_as_is(tmp_path):
    env = tmp_path / ".env"
    env.write_text("# комментарий\nJARVIS_HOST=0.0.0.0\nGITHUB_TOKEN=\nVAULT_GIT=c4erepk0/jarvis-vault\n")
    env.chmod(0o600)
    token = "github_pat_A/b&c|d\\e"          # символы, которые ломают sed
    vps("_set-env", str(env), "GITHUB_TOKEN", token)
    vps("_set-env", str(env), "JARVIS_HOST", "127.0.0.1")
    vps("_set-env", str(env), "JARVIS_ACCESS_CODE", "code-123")
    vps("_set-env", str(env), "JARVIS_ACCESS_CODE", "code-456")   # повторно — без дубля
    text = env.read_text()
    assert text.splitlines() == ["# комментарий", "JARVIS_HOST=127.0.0.1", f"GITHUB_TOKEN={token}",
                                 "VAULT_GIT=c4erepk0/jarvis-vault", "JARVIS_ACCESS_CODE=code-456"]
    assert env.stat().st_mode & 0o777 == 0o600                        # права на файл с токенами не слетели
    assert vps("_get-env", str(env), "GITHUB_TOKEN").strip() == token
    assert vps("_get-env", str(env), "NOPE") == ""
    assert vps("_get-env", str(tmp_path / "missing.env"), "X") == ""


def test_unit_and_caddy_site():
    unit = vps("_render-unit", JARVIS_DIR="/opt/jarvis", JARVIS_USER="jarvis")
    assert "User=jarvis" in unit and "WorkingDirectory=/opt/jarvis" in unit
    assert "ExecStart=/opt/jarvis/.venv/bin/python -m jarvis" in unit and "Restart=always" in unit
    site = vps("_render-caddy", "203-0-113-7.sslip.io", JARVIS_PORT="8765")
    assert "203-0-113-7.sslip.io {" in site and "reverse_proxy 127.0.0.1:8765" in site


def test_script_is_valid_and_has_help():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)
    assert "update" in vps("help")
    bad = subprocess.run(["bash", str(SCRIPT), "deploy-everything"], capture_output=True, text=True)
    assert bad.returncode != 0 and "Неизвестная команда" in bad.stderr
