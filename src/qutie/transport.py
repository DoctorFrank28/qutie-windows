"""Classic Bluetooth (SPP/RFCOMM) link to the Qutie, without COM ports.

Python 3.9+ on Windows opens RFCOMM sockets directly. The printer must already be
paired and free, i.e. not connected to a phone.
"""

from __future__ import annotations

import os
import random
import re
import socket
import sys
import time
from dataclasses import dataclass

from . import protocol

QUTIE_NAMES = re.compile(r"qutie|hprt|\bq2\b", re.IGNORECASE)
CHANNELS = (1, 2, 3, 4, 5, 6)


class PrinterError(RuntimeError):
    pass


@dataclass
class Device:
    mac: str
    name: str


def paired_devices() -> list[Device]:
    """Bluetooth devices known to Windows, read from the registry."""
    if sys.platform != "win32":
        return []
    import winreg

    root = r"SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices"
    found = []
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, root)
    except OSError:
        return []
    with key:
        i = 0
        while True:
            try:
                sub = winreg.EnumKey(key, i)
            except OSError:
                break
            i += 1
            name = ""
            try:
                with winreg.OpenKey(key, sub) as k:
                    value, _ = winreg.QueryValueEx(k, "Name")
                    name = value.split(b"\x00", 1)[0].decode("utf-8", "replace") if isinstance(value, bytes) else str(value)
            except OSError:
                pass
            if re.fullmatch(r"[0-9a-fA-F]{12}", sub):
                mac = ":".join(sub[j:j + 2] for j in range(0, 12, 2)).upper()
                found.append(Device(mac, name))
    return found


def find_mac(mac: str | None = None) -> str:
    """Explicit MAC, then the QUTIE_MAC variable, then the only paired device named like a Qutie."""
    mac = mac or os.environ.get("QUTIE_MAC")
    if mac:
        return mac.upper()
    candidates = [d for d in paired_devices() if QUTIE_NAMES.search(d.name)]
    if not candidates:
        raise PrinterError(
            "No paired Qutie found. Pair it (`qutie pair` or Windows Settings > Bluetooth & devices) "
            "or pass --mac (see `qutie devices`)."
        )
    if len(candidates) > 1:
        listing = ", ".join(f"{d.name} ({d.mac})" for d in candidates)
        raise PrinterError(f"More than one possible printer: {listing}. Pick one with --mac.")
    return candidates[0].mac


class Printer:
    """An open connection to the printer. Use it with `with`."""

    def __init__(self, mac: str, channel: int | None = None, timeout: float = 10.0, log=None, handshake: bool = True):
        self.mac = mac
        self.channel = channel
        self.timeout = timeout
        self.use_handshake = handshake
        self.log = log or (lambda msg: None)
        self.sock: socket.socket | None = None
        self.key: int | None = None  # XOR key for writes, if the printer accepted the handshake

    def __enter__(self) -> Printer:
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def open(self) -> None:
        channels = (self.channel,) if self.channel else CHANNELS
        last_error: OSError | None = None
        for channel in channels:
            s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
            s.settimeout(self.timeout)
            try:
                self.log(f"connecting to {self.mac} channel {channel}…")
                s.connect((self.mac, channel))
            except OSError as e:
                s.close()
                last_error = e
                continue
            self.sock = s
            self.channel = channel
            break
        if self.sock is None:
            raise PrinterError(
                f"Cannot connect to {self.mac}: {last_error}. "
                "Is the printer on, paired and not connected to a phone?"
            )
        if self.use_handshake:
            self._handshake()

    def _handshake(self) -> None:
        k1, k2 = random.randint(1, 100), random.randint(1, 100)
        reply = b""
        for _ in range(2):  # the SDK retries once when there is no reply
            self._send(protocol.handshake(k1, k2))
            reply = self.read(2.0, expected=2)
            if reply:
                break
        self.log(f"handshake: {reply!r}")
        if reply[:2] == b"OK":
            self.key = (k1 + k2) & 0xFF
        elif reply[:2] == b"NG":
            self.key = None
        else:
            raise PrinterError(f"Handshake failed (reply {reply!r}).")

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def _send(self, data: bytes) -> None:
        assert self.sock is not None
        self.sock.sendall(data)

    def write(self, data: bytes) -> None:
        if self.key is not None:
            data = bytes(b ^ self.key for b in data)
        self._send(data)

    def read(self, wait: float = 1.0, expected: int | None = None) -> bytes:
        """Read whatever arrives within `wait` seconds (up to `expected` bytes, if given)."""
        assert self.sock is not None
        data = bytearray()
        deadline = time.monotonic() + wait
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or (expected is not None and len(data) >= expected):
                break
            self.sock.settimeout(left if not data else min(left, 0.3))
            try:
                chunk = self.sock.recv(1024)
            except (TimeoutError, socket.timeout):
                if data:
                    break
                continue
            if not chunk:
                break
            data.extend(chunk)
        self.sock.settimeout(self.timeout)
        return bytes(data)

    def _drain(self) -> None:
        self.read(0.2)

    def status(self) -> protocol.Status:
        self._drain()
        self.write(protocol.CMD_STATUS)
        return protocol.Status.from_bytes(self.read(2.0, expected=17))

    def info(self) -> protocol.Info:
        self._drain()
        self.write(protocol.CMD_INFO)
        return protocol.Info.from_bytes(self.read(2.0, expected=143))

    def run(self, writes: list[bytes], progress=None) -> None:
        for i, data in enumerate(writes, 1):
            self.write(data)
            if progress:
                progress(i, len(writes))

    def wait_printed(self, labels: int = 1, timeout: float = 8.0) -> bool:
        """Wait until the printer reports the end of `labels` prints ("dithering_finish").

        Closing the link too early can cut a job short; the printer sends this
        notice once it has received and processed a label.
        """
        seen = b""
        deadline = time.monotonic() + timeout * max(1, labels)
        while time.monotonic() < deadline:
            seen += self.read(min(1.0, max(0.0, deadline - time.monotonic())))
            if seen.count(b"dithering_finish") >= labels:
                return True
        return False
