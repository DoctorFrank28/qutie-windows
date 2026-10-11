"""Live printer operations shared by the app windows (status, settings, sending jobs)."""

from __future__ import annotations

import time
from dataclasses import asdict

from .. import protocol, render, winsys
from ..config import Config
from ..transport import Printer, PrinterError, find_mac

# Density the UI allows: the printer reports 95 out of the box and the app prints at 75.
DENSITY_RANGE = (50, 100)


def _printer() -> Printer:
    return Printer(find_mac(Config.load().mac))


def _plain(obj) -> dict:
    return {k: v for k, v in asdict(obj).items() if k != "raw"}


def _failure(e: Exception, connected: bool) -> dict:
    # Connected but silent: the printer is stuck (or busy with another device) until it restarts.
    return {"ok": False, "detail": str(e), "reason": "no_reply" if connected else "unreachable"}


def read(attempts: int = 2) -> dict:
    """Model, firmware, battery and settings, read over Bluetooth.

    Right after a print the printer can refuse a new link for a moment: try again once.
    """
    for attempt in range(attempts):
        printer = _printer()
        try:
            with printer:
                info, status = printer.info(), printer.status()
                mac = printer.mac
            break
        except (PrinterError, OSError, ValueError) as e:
            if attempt == attempts - 1:
                return _failure(e, connected=printer.channel is not None)
            time.sleep(1.5)
    return {
        "ok": True,
        "mac": mac,
        "com_port": winsys.com_port(mac),
        "info": _plain(info),
        "status": _plain(status),
        "density_range": DENSITY_RANGE,
        "auto_off_choices": sorted(set(protocol.AUTO_OFF_CHOICES) | {status.auto_off_min}),
    }


def apply(density: int | None, auto_off_min: int | None) -> dict:
    """Change the settings stored in the printer; returns the status read back."""
    writes = []
    if density is not None:
        low, high = DENSITY_RANGE
        writes.append(protocol.density(max(low, min(high, int(density)))))
    if auto_off_min is not None:
        writes.append(protocol.auto_off(int(auto_off_min)))
    try:
        with _printer() as printer:
            for data in writes:
                printer.write(data)
            status = printer.status()
    except (PrinterError, OSError, ValueError) as e:
        return {"ok": False, "detail": str(e)}
    return {"ok": True, "status": _plain(status)}


def feed(mm: float = protocol.FEED_MM) -> dict:
    try:
        with _printer() as printer:
            printer.write(protocol.feed(mm))
            time.sleep(0.5)
    except (PrinterError, OSError) as e:
        return {"ok": False, "detail": str(e)}
    return {"ok": True}


def test_label(text: str = "Qutie OK", length_mm: float = 40, mac: str | None = None) -> dict:
    data = b"".join(protocol.job(render.text(text, length_mm=length_mm), length_mm=length_mm))
    return send(data, labels=1, mac=mac)


def send(data: bytes, copies: int = 1, labels: int | None = None, mac: str | None = None) -> dict:
    """Send raw printer bytes (e.g. a job from the Windows driver) over Bluetooth.

    Waits for the printer to confirm each label before closing the link.
    """
    from .. import spool

    per_copy = labels if labels is not None else max(1, len(spool.parse(data).labels))
    copies = max(1, int(copies))
    try:
        with Printer(mac) if mac else _printer() as printer:
            for _ in range(copies):
                printer.write(data)
                time.sleep(0.1)
            printer.wait_printed(per_copy * copies)
    except (PrinterError, OSError, ValueError) as e:
        return {"ok": False, "detail": str(e)}
    return {"ok": True}
