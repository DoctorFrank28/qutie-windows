"""Setup wizard: finds the Qutie, pairs it and installs (or removes) the Windows printer."""

from __future__ import annotations

import sys
from pathlib import Path

import webview

from .. import pairing, winsys
from ..transport import QUTIE_NAMES

WEB = Path(__file__).with_name("web")


def _last_error(log: str) -> str:
    errors = [line for line in log.splitlines() if line.startswith("Error:")]
    return errors[-1].removeprefix("Error:").strip() if errors else ""


class Api:
    """Methods called from JavaScript (window.pywebview.api.*). They run on worker threads."""

    def __init__(self) -> None:
        self._found: dict[str, pairing.Found] = {}
        self._window: webview.Window | None = None

    def mode(self) -> str:
        return "uninstall" if "--uninstall" in sys.argv else "install"

    def scan(self) -> list[dict]:
        found = pairing.scan()
        self._found = {f.mac: f for f in found}
        devices = [
            {"name": f.name, "mac": f.mac, "paired": f.paired, "qutie": bool(QUTIE_NAMES.search(f.name))}
            for f in found
        ]
        return sorted(devices, key=lambda d: (not d["qutie"], not d["paired"], d["name"].lower()))

    def pair(self, mac: str) -> dict:
        found = self._found.get(mac)
        if found is None:
            return {"ok": False, "detail": "device not visible any more"}
        if found.paired:
            return {"ok": True}
        try:
            result = pairing.pair(found.info)
        except Exception as e:  # noqa: BLE001 - shown to the user
            return {"ok": False, "detail": str(e)}
        return {"ok": result == "paired", "detail": result}

    def port(self, mac: str) -> str | None:
        return winsys.wait_for_port(mac)

    def test_direct(self, port: str, mac: str | None = None) -> dict:
        # Over a Bluetooth socket, not the COM port: Windows opens the serial link
        # lazily and a short write can be lost before the link is up.
        from .device import test_label

        return test_label(mac=mac)

    def printer(self) -> dict | None:
        return winsys.installed_printer()

    def install(self, port: str) -> dict:
        from .agent import request

        request("quit")  # the running app holds the old printer open and would block the update
        ok, log = winsys.install_driver(port)
        if ok:
            # The Qutie app receives the jobs of the Windows printer: start it now and at sign-in.
            winsys.set_autostart(True)
            winsys.launch_self("--background")
        return {"ok": bool(ok), "cancelled": ok is None, "detail": _last_error(log), "log": log}

    def uninstall(self, remove_pairing: bool) -> dict:
        from .agent import request

        request("quit")  # the running app would keep its folder in Program Files busy
        ok, log = winsys.uninstall_driver()
        if ok:
            winsys.set_autostart(False)
        if ok and remove_pairing:
            try:
                removed = pairing.unpair()
                log += "\n\n> Bluetooth pairing\n  " + (", ".join(removed) + " removed" if removed else "no paired Qutie")
            except Exception as e:  # noqa: BLE001
                log += f"\n\nBluetooth pairing not removed: {e}"
        return {"ok": bool(ok), "cancelled": ok is None, "detail": _last_error(log), "log": log}

    def test_windows(self) -> dict:
        try:
            winsys.test_page()
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "detail": str(e)}

    def open_app(self) -> None:
        """Open the Qutie app's settings window (starting the app if needed)."""
        winsys.launch_self()

    def close(self) -> None:
        if self._window:
            self._window.destroy()


def main() -> int:
    api = Api()
    window = webview.create_window(
        "Qutie",
        str(WEB / "wizard.html"),
        js_api=api,
        width=620,
        height=680,
        min_size=(500, 580),
    )
    api._window = window
    webview.start(debug="--debug" in sys.argv)
    return 0


if __name__ == "__main__":
    sys.exit(main())
