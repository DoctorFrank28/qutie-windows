"""Minimal LZO1X.

The printer expects every raster block compressed with LZO1X (the official app uses
lzo1x_1_compress). Real compression is not required: a stream made only of literals
is valid LZO1X and the printer decompresses it like any other. The decompressor is
used by the tests and to inspect captures of the official app's traffic.
"""

END_OF_STREAM = b"\x11\x00\x00"


def compress(data: bytes) -> bytes:
    """Encode `data` as a single LZO1X literal run."""
    n = len(data)
    if n == 0:
        return END_OF_STREAM
    if n <= 238:
        # First byte > 17: the initial literal count is byte - 17.
        return bytes([n + 17]) + data + END_OF_STREAM
    # Long literal run: 0x00, then zero bytes (+255 each), then the remainder (>= 1).
    rest = n - 3 - 15
    zeros, last = divmod(rest, 255)
    if last == 0:
        zeros, last = zeros - 1, 255
    return b"\x00" + b"\x00" * zeros + bytes([last]) + data + END_OF_STREAM


class LZOError(ValueError):
    pass


def decompress(src: bytes) -> bytes:
    """LZO1X decompressor (same structure as lzo1x_decompress_safe)."""
    out = bytearray()
    ip = 0

    def byte() -> int:
        nonlocal ip
        if ip >= len(src):
            raise LZOError("truncated stream")
        b = src[ip]
        ip += 1
        return b

    def literals(t: int) -> None:
        nonlocal ip
        if ip + t > len(src):
            raise LZOError("literal run past the end")
        out.extend(src[ip:ip + t])
        ip += t

    def extended_length(base: int) -> int:
        t = 0
        while True:
            b = byte()
            if b:
                return t + base + b
            t += 255

    def copy(distance: int, length: int) -> None:
        pos = len(out) - distance
        if pos < 0:
            raise LZOError("back reference before the start")
        for i in range(length):  # byte by byte: copies may overlap
            out.append(out[pos + i])

    state = "loop"
    t = 0
    if src and src[0] > 17:
        t = byte() - 17
        literals(t)
        if t < 4:
            t = byte()
            state = "match"
        else:
            state = "first_literal_run"

    while True:
        if state == "loop":
            t = byte()
            if t >= 16:
                state = "match"
                continue
            if t == 0:
                t = extended_length(15)
            literals(t + 3)
            state = "first_literal_run"
            continue

        if state == "first_literal_run":
            t = byte()
            if t >= 16:
                state = "match"
                continue
            copy(1 + 0x0800 + (t >> 2) + (byte() << 2), 3)
            state = "match_done"
            continue

        if state == "match":
            if t >= 64:
                distance = 1 + ((t >> 2) & 7) + (byte() << 3)
                copy(distance, (t >> 5) + 1)
            elif t >= 32:
                t &= 31
                if t == 0:
                    t = extended_length(31)
                lo, hi = byte(), byte()
                copy(1 + ((lo | (hi << 8)) >> 2), t + 2)
            elif t >= 16:
                distance = (t & 8) << 11
                t &= 7
                if t == 0:
                    t = extended_length(7)
                lo, hi = byte(), byte()
                distance += (lo | (hi << 8)) >> 2
                if distance == 0:
                    if ip != len(src):
                        raise LZOError("data after the end of stream")
                    return bytes(out)
                copy(distance + 0x4000, t + 2)
            else:
                copy(1 + (t >> 2) + (byte() << 2), 2)
            state = "match_done"
            continue

        if state == "match_done":
            t = src[ip - 2] & 3
            if t == 0:
                state = "loop"
                continue
            literals(t)
            t = byte()
            state = "match"
            continue
