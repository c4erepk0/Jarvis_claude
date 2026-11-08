@echo off
cd /d "%~dp0"
if not exist .venv ( py -3 -m venv .venv )
.venv\Scripts\python -m pip install -q -r requirements.txt
if not exist .env ( copy .env.example .env )
.venv\Scripts\python -m jarvis
pause
