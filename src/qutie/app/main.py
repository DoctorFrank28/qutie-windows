"""Entry point of Qutie.exe.

- --app (or no arguments): the app (tray icon, print preview) with its main window:
  Qutie Studio when it is installed, otherwise the settings;
- --studio [file.qutie]: the app with Qutie Studio (the Start menu entry, .qutie files);
- --quick: the app with the "quick print" window;
- --background: the app without opening any window (started with Windows);
- --setup / --uninstall: the setup wizard.

With no arguments, an executable whose name contains "setup" (the downloadable
"Qutie-Setup.exe") opens the wizard. Whoever starts the app from code passes --app
explicitly, so the file name never decides (see winsys.launch_self).
"""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    args = sys.argv[1:]
    named_setup = getattr(sys, "frozen", False) and "setup" in Path(sys.executable).stem.lower()
    if "--setup" in args or "--uninstall" in args or (named_setup and not args):
        from .wizard import main as wizard

        return wizard()
    from .agent import main as agent

    if "--studio" in args:
        rest = [a for a in args[args.index("--studio") + 1:] if not a.startswith("--")]
        studio = {"path": str(Path(rest[0]).resolve())} if rest else {}
        return agent(studio=studio)
    if "--quick" in args:
        return agent(quick=True)
    # --section paper|device|…: the settings section to show (the driver plug-in uses it).
    section = args[args.index("--section") + 1] if "--section" in args[:-1] else None
    return agent(show_settings="--background" not in args, section=section)


if __name__ == "__main__":
    sys.exit(main())
