# PyInstaller: one executable for the whole app (tray, preview, settings, Qutie Studio, setup wizard).
# Build:  uv run pyinstaller packaging/qutie.spec --noconfirm
# The release ships it twice: "Qutie-Setup.exe" (opens the setup wizard, see
# qutie.app.main) and, once installed, "C:\Program Files\Qutie\Qutie.exe".
import shutil
from pathlib import Path

from PyInstaller.utils.hooks import collect_dynamic_libs, collect_submodules

ROOT = Path(SPECPATH).parent

a = Analysis(
    [str(ROOT / "packaging" / "app_entry.py")],
    pathex=[str(ROOT / "src")],
    datas=[
        (str(ROOT / "src" / "qutie" / "app" / "web"), "qutie/app/web"),
        (str(ROOT / "driver" / "qutie.inf"), "driver"),
        (str(ROOT / "driver" / "QUTIE.GPD"), "driver"),
        (str(ROOT / "driver" / "QUTIE.INI"), "driver"),
        (str(ROOT / "driver" / "amd64" / "QUTIEUI.DLL"), "driver/amd64"),
        (str(ROOT / "driver" / "install.ps1"), "driver"),
        (str(ROOT / "driver" / "uninstall.ps1"), "driver"),
        (str(ROOT / "driver" / "components.ps1"), "driver"),
    ],
    binaries=collect_dynamic_libs("zxingcpp"),
    hiddenimports=collect_submodules("winrt") + ["pystray._win32", "zxingcpp", "openpyxl"],
    excludes=["tkinter", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name="Qutie",
    icon=str(ROOT / "packaging" / "qutie.ico"),
    console=False,
    upx=False,
)

dist = Path(DISTPATH)
shutil.copy2(dist / "Qutie.exe", dist / "Qutie-Setup.exe")
