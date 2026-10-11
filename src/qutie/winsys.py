"""Windows integration: Bluetooth COM port, system printer, driver installer."""

from __future__ import annotations

import ctypes
import ctypes.wintypes as w
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

PRINTER_NAME = "Qutie"
DRIVER_NAME = "HPRT Qutie"
_NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW

# The Windows printer writes each job here; the Qutie app previews it and sends it.
SPOOL_DIR = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Qutie" / "spool"
SPOOL_FILE = SPOOL_DIR / "job.prn"

STARTUP_LINK = Path(os.environ.get("APPDATA", "")) / r"Microsoft\Windows\Start Menu\Programs\Startup\Qutie.lnk"
INSTALLED_EXE = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Qutie" / "Qutie.exe"


def _app_command(*arguments: str) -> list[str]:
    """Command line of the Qutie app: the installed copy when there is one."""
    if getattr(sys, "frozen", False):
        exe = INSTALLED_EXE if INSTALLED_EXE.exists() else Path(sys.executable)
        return [str(exe), *arguments]
    return [str(Path(sys.executable).with_name("pythonw.exe")), "-m", "qutie.app.main", *arguments]

_PT = {
    "psf": "http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework",
    "psk": "http://schemas.microsoft.com/windows/2003/08/printing/printschemakeywords",
}


def powershell(command: str, timeout: float = 60) -> str:
    """Run a Windows PowerShell command without opening a window and return its output."""
    r = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
         "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " + command],
        capture_output=True, timeout=timeout, creationflags=_NO_WINDOW,
    )
    return r.stdout.decode("utf-8", "replace").strip()


def driver_dir() -> Path:
    """Driver files: next to the bundled executable, or in driver/ in the repository."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "driver"  # type: ignore[attr-defined]
    return Path(__file__).resolve().parents[2] / "driver"


def com_port(mac: str) -> str | None:
    """The outgoing COM port Windows created for the SPP device with this MAC."""
    key = mac.replace(":", "").upper()
    out = powershell(
        "Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | "
        f"Where-Object {{ $_.InstanceId -match '&{key}_' }} | "
        "ForEach-Object { if ($_.FriendlyName -match '\\((COM\\d+)\\)') { $Matches[1] } } | Select-Object -First 1"
    )
    return out or None


def wait_for_port(mac: str, seconds: float = 40) -> str | None:
    """After pairing, Windows takes a few seconds to create the COM port."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        port = com_port(mac)
        if port:
            return port
        time.sleep(2)
    return None


def installed_printer(name: str = PRINTER_NAME) -> dict | None:
    out = powershell(
        f"Get-Printer -Name '{name}' -ErrorAction SilentlyContinue | "
        "Select-Object Name, DriverName, PortName | ConvertTo-Json -Compress"
    )
    return json.loads(out) if out else None


def write_to_port(port: str, data: bytes) -> None:
    """Write bytes to the Bluetooth COM port, as the spooler does (read/write access)."""
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateFileW.restype = w.HANDLE
    k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
    h = k.CreateFileW(rf"\\.\{port}", 0xC0000000, 0, None, 3, 0, None)
    if h in (None, w.HANDLE(-1).value):
        raise OSError(ctypes.get_last_error(), f"Cannot open {port}")
    try:
        written = w.DWORD()
        if not k.WriteFile(h, data, len(data), ctypes.byref(written), None) or written.value != len(data):
            raise OSError(ctypes.get_last_error(), f"Write to {port} failed")
        time.sleep(1.5)  # let the last bytes leave before the link closes
    finally:
        k.CloseHandle(h)


class _SHELLEXECUTEINFOW(ctypes.Structure):
    _fields_ = [
        ("cbSize", w.DWORD), ("fMask", w.ULONG), ("hwnd", w.HWND), ("lpVerb", w.LPCWSTR),
        ("lpFile", w.LPCWSTR), ("lpParameters", w.LPCWSTR), ("lpDirectory", w.LPCWSTR),
        ("nShow", ctypes.c_int), ("hInstApp", w.HINSTANCE), ("lpIDList", w.LPVOID),
        ("lpClass", w.LPCWSTR), ("hkeyClass", w.HKEY), ("dwHotKey", w.DWORD),
        ("hIconOrMonitor", w.HANDLE), ("hProcess", w.HANDLE),
    ]


def run_as_admin(program: str, parameters: str) -> int:
    """Start with UAC, wait for it and return the exit code (-1 if UAC was declined)."""
    info = _SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = 0x00000040  # SEE_MASK_NOCLOSEPROCESS
    info.lpVerb = "runas"
    info.lpFile = program
    info.lpParameters = parameters
    info.nShow = 0  # SW_HIDE
    if not ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(info)):
        return -1
    k = ctypes.windll.kernel32
    k.WaitForSingleObject(info.hProcess, 0xFFFFFFFF)
    code = w.DWORD()
    k.GetExitCodeProcess(info.hProcess, ctypes.byref(code))
    k.CloseHandle(info.hProcess)
    return code.value


def _admin_script(script_name: str, parameters: str) -> tuple[bool | None, str]:
    """Run a driver/ script as administrator.

    Returns (succeeded, log); succeeded is None when UAC was declined.
    """
    script = driver_dir() / script_name
    log = Path(tempfile.gettempdir()) / f"qutie-{script.stem}-{int(time.time())}.log"
    code = run_as_admin(
        "powershell.exe",
        f'-NoProfile -ExecutionPolicy Bypass -File "{script}" {parameters} -Quiet -Log "{log}"',
    )
    if code == -1:
        return None, ""
    lines = log.read_text(encoding="utf-8", errors="replace").splitlines() if log.exists() else []
    lines = [r for r in lines if r.strip() and not r.startswith("*" * 10)]
    # Keep only the steps: drop the transcript header and footer.
    start = next((i for i, r in enumerate(lines) if r.startswith(">")), 0)
    lines = [r for r in lines[start:] if not r.lower().startswith(("transcript", "trascrizione", "fine trascrizione"))]
    return code == 0, "\n".join(lines)


def install_driver(port: str, name: str = PRINTER_NAME) -> tuple[bool | None, str]:
    parameters = f'-Port {port} -Name "{name}" -SpoolFile "{SPOOL_FILE}"'
    if getattr(sys, "frozen", False):
        parameters += f' -Executable "{sys.executable}"'
    return _admin_script("install.ps1", parameters)


def uninstall_driver(name: str = PRINTER_NAME) -> tuple[bool | None, str]:
    return _admin_script("uninstall.ps1", f'-Name "{name}"')


def _local(qname: str | None) -> str:
    """'ns0000:Q12X40' -> 'Q12X40', 'psk:Landscape' -> 'Landscape'."""
    return (qname or "").split(":")[-1]


def driver_defaults(name: str = PRINTER_NAME) -> dict[str, str]:
    """Default options of the Windows printer, as {feature: option} without namespace prefixes."""
    xml = powershell(f"(Get-PrintConfiguration -PrinterName '{name}').PrintTicketXML")
    if not xml:
        return {}
    root = ET.fromstring(xml)
    result = {}
    for feature in root.findall("psf:Feature", _PT):
        option = feature.find("psf:Option", _PT)
        if option is not None:
            result[_local(feature.get("name"))] = _local(option.get("name"))
    return result


def set_driver_defaults(changes: dict[str, str], name: str = PRINTER_NAME) -> dict[str, str]:
    """Change default options ({feature: option}, names without prefixes) and return the result."""
    xml = powershell(f"(Get-PrintConfiguration -PrinterName '{name}').PrintTicketXML")
    # Edit the text instead of re-serializing: option names are QNames whose prefixes
    # (psk, ns0000…) must stay exactly as declared in the ticket.
    for key, value in changes.items():
        pattern = re.compile(
            r'(<psf:Feature name="[^"]*:' + re.escape(key) + r'">\s*)'
            r'<psf:Option name="([^":]*):[^"]*"(?:\s*/>|>.*?</psf:Option>)',
            re.S,
        )
        prefix = "psk" if value in ("Landscape", "Portrait") else None
        # Drop the scored properties too (e.g. media size): Windows fills them in for the new option.
        xml = pattern.sub(lambda m: f'{m.group(1)}<psf:Option name="{prefix or m.group(2)}:{value}" />', xml)
    ticket = Path(tempfile.gettempdir()) / f"qutie-ticket-{os.getpid()}.xml"
    ticket.write_text(xml, encoding="utf-8")
    try:
        powershell(f"Set-PrintConfiguration -PrinterName '{name}' -PrintTicketXml (Get-Content -Raw -Encoding UTF8 '{ticket}')")
    finally:
        ticket.unlink(missing_ok=True)
    return driver_defaults(name)


def autostart_enabled() -> bool:
    return STARTUP_LINK.exists()


def set_autostart(enabled: bool) -> None:
    """Start the Qutie app (in the background) when the user signs in."""
    if not enabled:
        STARTUP_LINK.unlink(missing_ok=True)
        return
    target, *rest = _app_command("--background")
    arguments = subprocess.list2cmdline(rest)
    powershell(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('" + str(STARTUP_LINK) + "');"
        f"$s.TargetPath='{target}';$s.Arguments='{arguments}';$s.Save()"
    )


def launch_self(*arguments: str) -> None:
    """Start the Qutie app (the installed copy when there is one).

    Without arguments it opens the app's settings window: "--app" is explicit because
    "Qutie Setup.exe" started without arguments would open the setup wizard again.
    """
    subprocess.Popen(_app_command(*(arguments or ("--app",))), creationflags=_NO_WINDOW)


def open_printer_dialog(kind: str, name: str = PRINTER_NAME) -> None:
    """Open the Windows dialog: "preferences" (Printing preferences) or "properties" (Printer properties)."""
    flag = {"preferences": "/e", "properties": "/p"}[kind]
    subprocess.Popen(["rundll32.exe", "printui.dll,PrintUIEntry", flag, "/n", name], creationflags=_NO_WINDOW)


_TEST_PAGE = r"""
Add-Type -AssemblyName System.Drawing
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = '{name}'
$doc.DocumentName = 'Qutie test page'
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$doc.add_PrintPage({{
    param($sender, $e)
    $area = $e.PageBounds
    $g = $e.Graphics
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
    # Largest bold font that fits the label, with a thin frame around it.
    $size = 40
    do {{
        $font = New-Object System.Drawing.Font('Arial', $size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
        $text = $g.MeasureString('{content}', $font)
        $size -= 1
    }} while (($text.Width -gt $area.Width * 0.9 -or $text.Height -gt $area.Height * 0.8) -and $size -gt 4)
    $g.DrawRectangle([System.Drawing.Pens]::Black, 2, 2, $area.Width - 5, $area.Height - 5)
    $g.DrawString('{content}', $font, [System.Drawing.Brushes]::Black,
        ($area.Width - $text.Width) / 2, ($area.Height - $text.Height) / 2)
    $e.HasMorePages = $false
}})
$doc.Print()
"""


def test_page(name: str = PRINTER_NAME, content: str = "Qutie OK") -> None:
    """Print a test label through the Windows printer (so through the driver and the app).

    Out-Printer is not usable here: it fails on a page as small as a label.
    """
    out = powershell(_TEST_PAGE.format(name=name.replace("'", "''"), content=content.replace("'", "''")))
    if "Exception" in out or "Errore" in out or "Error" in out:
        raise RuntimeError(out.strip().splitlines()[-1])
