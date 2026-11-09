"""Диагностика систем — как диагностика костюма: процессор, память, диск, сеть, аптайм, батарея."""
from __future__ import annotations

import os
import platform
import time

import psutil

_last_net: tuple[float, int, int] | None = None
_started = time.time()


def snapshot(disk_path: str = ".") -> dict:
    global _last_net
    vm = psutil.virtual_memory()
    try:
        du = psutil.disk_usage(disk_path)
        disk = {"percent": round(du.percent), "free_gb": round(du.free / 2**30, 1), "total_gb": round(du.total / 2**30)}
    except OSError:
        disk = None
    now = time.time()
    net = psutil.net_io_counters()
    rx = tx = 0.0
    if _last_net and now > _last_net[0]:
        dt = now - _last_net[0]
        rx = max(0.0, (net.bytes_recv - _last_net[1]) / dt)
        tx = max(0.0, (net.bytes_sent - _last_net[2]) / dt)
    _last_net = (now, net.bytes_recv, net.bytes_sent)
    temps = None
    try:
        sensors = psutil.sensors_temperatures() if hasattr(psutil, "sensors_temperatures") else {}
        values = [t.current for group in sensors.values() for t in group if t.current]
        temps = round(max(values)) if values else None
    except (OSError, AttributeError):
        temps = None
    battery = None
    try:
        b = psutil.sensors_battery()
        if b:
            battery = {"percent": round(b.percent), "plugged": b.power_plugged}
    except (OSError, AttributeError, NotImplementedError):
        battery = None
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except (OSError, AttributeError):
        load = None
    proc = psutil.Process()
    return {
        "host": platform.node(), "os": f"{platform.system()} {platform.release()}",
        "cpu": round(psutil.cpu_percent(interval=None)), "cores": psutil.cpu_count(),
        "load": load,
        "ram": {"percent": round(vm.percent), "used_gb": round(vm.used / 2**30, 1),
                "total_gb": round(vm.total / 2**30, 1)},
        "disk": disk,
        "net": {"rx_kbs": round(rx / 1024, 1), "tx_kbs": round(tx / 1024, 1)},
        "temp": temps, "battery": battery,
        "uptime_h": round((now - psutil.boot_time()) / 3600, 1),
        "jarvis": {"uptime_min": round((now - _started) / 60), "rss_mb": round(proc.memory_info().rss / 2**20)},
    }


def phrase(d: dict) -> str:
    parts = [f"Процессор загружен на {d['cpu']}%", f"память — {d['ram']['percent']}%"]
    if d.get("disk"):
        parts.append(f"диск заполнен на {d['disk']['percent']}%, свободно {d['disk']['free_gb']} ГБ")
    if d.get("temp"):
        parts.append(f"температура {d['temp']}°")
    if d.get("battery"):
        parts.append(f"батарея {d['battery']['percent']}%")
    return ", ".join(parts) + "."


def problems(d: dict, cpu: int, ram: int, disk: int) -> list[str]:
    out = []
    if d["cpu"] >= cpu:
        out.append(f"процессор загружен на {d['cpu']}%")
    if d["ram"]["percent"] >= ram:
        out.append(f"память заполнена на {d['ram']['percent']}%")
    if d.get("disk") and d["disk"]["percent"] >= disk:
        out.append(f"на диске осталось {d['disk']['free_gb']} ГБ")
    return out
