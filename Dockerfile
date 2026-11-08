FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    JARVIS_HOST=0.0.0.0 VAULT_PATH=/vault JARVIS_DATA_DIR=/data
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY jarvis ./jarvis
COPY vault-template ./vault-template
RUN useradd -u 1000 -m jarvis && mkdir -p /vault /data && chown jarvis:jarvis /vault /data
USER jarvis
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/healthz')"
CMD ["python", "-m", "jarvis"]
