"""Generates packaging/qutie.ico from qutie.app.icon."""

from pathlib import Path

from qutie.app.icon import draw

target = Path(__file__).with_name("qutie.ico")
draw(256).save(target, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(target)
