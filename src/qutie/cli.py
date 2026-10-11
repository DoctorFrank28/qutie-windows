"""Command line: `qutie text "Hello"`, `qutie image logo.png`, `qutie status`…"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from . import protocol, render
from .transport import QUTIE_NAMES, Printer, PrinterError, find_mac, paired_devices


def _connection_options(p: argparse.ArgumentParser) -> None:
    p.add_argument("--mac", help="printer address (default: QUTIE_MAC or the paired Qutie)")
    p.add_argument("--channel", type=int, help="RFCOMM channel (default: try 1-6)")
    p.add_argument("-v", "--verbose", action="store_true", help="show the connection steps")


def _print_options(p: argparse.ArgumentParser) -> None:
    paper = p.add_mutually_exclusive_group()
    paper.add_argument("-l", "--length", type=float, default=40, help="label length in mm (default 40)")
    paper.add_argument("--continuous", action="store_true", help="continuous paper: the length follows the content")
    p.add_argument("--feed", type=float, default=protocol.FEED_MM, help="mm to feed after printing on continuous paper")
    p.add_argument("--extra", type=float, default=protocol.EXTRA_MM,
                   help=f"extra mm to feed after each label (default {protocol.EXTRA_MM})")
    p.add_argument("-n", "--copies", type=int, default=1)
    p.add_argument("--density", type=int, help="print density (default: keep the printer's setting)")
    p.add_argument("--rotate", type=int, default=render.ROTATE, choices=(90, 270),
                   help="direction of the content on the label (default 270: reads in print order)")
    p.add_argument("--preview", type=Path, help="save a PNG of the label instead of printing")
    p.add_argument("--save-data", type=Path, help="save the bytes sent (in clear) to a file")
    _connection_options(p)


def _log(args):
    return (lambda msg: print(msg, file=sys.stderr)) if args.verbose else None


def _print(args, img) -> int:
    length = None if args.continuous else args.length
    if args.preview:
        render.preview(img, args.rotate).save(args.preview)
        print(f"Preview saved to {args.preview} ({img.width}×{img.height} dots)")
        return 0
    writes = protocol.job(img, length_mm=length, feed_mm=args.feed, extra_mm=args.extra, print_density=args.density)
    if args.save_data:
        args.save_data.write_bytes(b"".join(writes) * args.copies)
    mac = find_mac(args.mac)
    with Printer(mac, args.channel, log=_log(args)) as printer:
        for _ in range(args.copies):
            printer.run(writes)
            time.sleep(0.1)  # like the app between copies
        print(f"Sent {args.copies} label(s) to {mac}.")
    return 0


def cmd_text(args) -> int:
    content = args.text.replace("\\n", "\n")
    img = render.text(content, length_mm=None if args.continuous else args.length,
                      font=args.font, size=args.size, rotate=args.rotate)
    return _print(args, img)


def cmd_image(args) -> int:
    img = render.image(args.file, length_mm=None if args.continuous else args.length,
                       rotate=args.rotate, dither=args.dither)
    return _print(args, img)


def cmd_devices(args) -> int:
    devices = paired_devices()
    if not devices:
        print("No Bluetooth devices found.")
    for d in devices:
        print(f"{d.mac}  {d.name}")
    return 0


def cmd_scan(args) -> int:
    from . import pairing

    print("Scanning (about 10 seconds)…")
    for found in pairing.scan():
        print(f"{'paired ' if found.paired else 'visible'}  {found.mac}  {found.name}")
    return 0


def cmd_pair(args) -> int:
    from . import pairing

    candidates = [f for f in pairing.scan() if not f.paired]
    if args.mac:
        candidates = [f for f in candidates if f.mac == args.mac.upper()]
    else:
        candidates = [f for f in candidates if QUTIE_NAMES.search(f.name)]
    if not candidates:
        print("No Qutie to pair: is it on and free from the phone? (If it is already paired, try `qutie status`.)")
        return 1
    found = candidates[0]
    print(f"{found.name} ({found.mac}): {pairing.pair(found.info, args.pin)}")
    return 0


def cmd_status(args) -> int:
    mac = find_mac(args.mac)
    with Printer(mac, args.channel, log=_log(args)) as printer:
        print(f"Printer:   {mac} (channel {printer.channel}, XOR {'on' if printer.key is not None else 'off'})")
        try:
            i = printer.info()
            print(f"Model:     {i.model}")
            print(f"Serial:    {i.serial}")
            print(f"Firmware:  {i.firmware} (board {i.board}, BT {i.bt_firmware})")
        except ValueError as e:
            print(f"Info unavailable: {e}")
        try:
            s = printer.status()
            print(f"Status:    {s.code}")
            print(f"Battery:   {s.battery}")
            print(f"Density:   {s.density}")
            print(f"Paper:     type {s.paper_type}")
            print(f"Auto off:  {s.auto_off_min} min")
            if args.verbose:
                print(f"Raw:       {s.raw.hex(' ')}")
        except ValueError as e:
            print(f"Status unavailable: {e}")
    return 0


def cmd_feed(args) -> int:
    mac = find_mac(args.mac)
    with Printer(mac, args.channel, log=_log(args)) as printer:
        printer.write(protocol.feed(args.mm))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="qutie", description="Print on the HPRT Qutie label maker over Bluetooth.")
    sub = p.add_subparsers(dest="command", required=True)

    t = sub.add_parser("text", help="print text (\\n for a new line)")
    t.add_argument("text")
    t.add_argument("--font", help=f"font file or name (default {render.DEFAULT_FONT})")
    t.add_argument("--size", type=int, help="font size in points (default: the largest that fits)")
    _print_options(t)
    t.set_defaults(func=cmd_text)

    i = sub.add_parser("image", help="print an image (PNG, JPG…)")
    i.add_argument("file", type=Path)
    i.add_argument("--dither", action="store_true", help="Floyd-Steinberg dithering, for photos and gradients")
    _print_options(i)
    i.set_defaults(func=cmd_image)

    d = sub.add_parser("devices", help="list the Bluetooth devices known to Windows")
    d.set_defaults(func=cmd_devices)

    sc = sub.add_parser("scan", help="scan for nearby Bluetooth devices")
    sc.set_defaults(func=cmd_scan)

    pr = sub.add_parser("pair", help="pair the Qutie with Windows")
    pr.add_argument("--mac", help="address to pair (default: the first visible device named Qutie)")
    pr.add_argument("--pin", help="PIN, if the printer asks for one (default 0000)")
    pr.set_defaults(func=cmd_pair)

    s = sub.add_parser("status", help="model, firmware, battery and density")
    _connection_options(s)
    s.set_defaults(func=cmd_status)

    f = sub.add_parser("feed", help="feed the paper")
    f.add_argument("mm", type=float, nargs="?", default=protocol.FEED_MM)
    _connection_options(f)
    f.set_defaults(func=cmd_feed)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except PrinterError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
