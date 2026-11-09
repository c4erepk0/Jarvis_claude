# Команды разработки Jarvis.  make help — список.
PY ?= .venv/bin/python
SH_FILES := start.sh start.command scripts/vps.sh

.PHONY: help dev test lint audit check run livesync-config

help:
	@echo "make dev    — создать .venv и поставить зависимости для разработки"
	@echo "make test   — все тесты: Python (pytest) и ядро для iPhone (node --test)"
	@echo "make lint   — flake8 + shellcheck"
	@echo "make audit  — уязвимости в зависимостях (pip-audit)"
	@echo "make check  — lint + test + audit (как в CI)"
	@echo "make run    — запустить Jarvis (нужен .env)"
	@echo "make livesync-config — собрать конфиг моста LiveSync из .env"

.venv/bin/python:
	python3 -m venv .venv

dev: .venv/bin/python
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -r requirements-dev.txt

test:
	$(PY) -m pytest
	node --test tests/js/*.test.mjs
	$(PY) scripts/build_template.py --check

lint:
	$(PY) -m flake8 --count
	.venv/bin/shellcheck -S error $(SH_FILES)

audit:
	.venv/bin/pip-audit -r requirements.txt

check: lint test audit

run:
	$(PY) -m jarvis

livesync-config:
	$(PY) scripts/livesync_config.py
