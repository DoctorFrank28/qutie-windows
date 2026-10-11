from qutie import protocol, render, spool


def test_parse_gap_labels_with_feed():
    img = render.text("One", length_mm=30)
    data = b"".join(protocol.job(img, length_mm=30)) * 2
    job = spool.parse(data)
    assert len(job.labels) == 2
    label = job.labels[0]
    assert len(label.rows) == img.height
    assert label.length_dots == protocol.mm_to_dots(30)
    assert label.feed_dots == protocol.mm_to_dots(protocol.EXTRA_MM)
    assert label.image().size == (96, img.height)
    assert job.setup == protocol.alignment(1)
    assert not job.blank


def test_parse_continuous_tape():
    img = render.text("Tape", length_mm=None)
    job = spool.parse(b"".join(protocol.job(img, length_mm=None, print_density=80)))
    assert len(job.labels) == 1
    assert job.labels[0].length_dots is None
    assert job.setup == protocol.density(80) + protocol.alignment(1)


def test_continuous_tape_is_trimmed_to_the_content():
    from PIL import Image

    # A 60 mm page with a 10-row black bar in the middle, as an app would print it.
    page = Image.new("L", (96, protocol.mm_to_dots(60)), 255)
    page.paste(0, (10, 200, 80, 210))
    job = spool.parse(b"".join(protocol.job(page, length_mm=None, feed_mm=10)))
    fitted = job.fit_to_content(margin_mm=2)
    margin = protocol.mm_to_dots(2)
    assert len(fitted.labels[0].rows) == 10 + 2 * margin
    assert fitted.labels[0].feed_dots == protocol.mm_to_dots(10)
    # The rebuilt bytes parse back to the same trimmed label.
    again = spool.parse(fitted.data)
    assert again.labels[0].rows == fitted.labels[0].rows


def test_blank_page_is_kept_for_the_preview():
    from PIL import Image

    # What Excel sends when its margins are larger than the label: a white page.
    page = Image.new("L", (96, protocol.mm_to_dots(40)), 255)
    job = spool.parse(b"".join(protocol.job(page, length_mm=None)))
    assert job.blank
    assert job.fit_to_content() is job and len(job.labels) == 1


def test_fit_to_tape_page_is_scaled_to_the_tape():
    from PIL import Image, ImageDraw

    from qutie import lzo

    # An A5 page (148-byte rows) with a block of "text" running down the page, as the
    # driver sends it for the "Fit to tape" paper size with GAP media (GS f 1677).
    page = Image.new("L", (148 * 8, 1677), 255)
    ImageDraw.Draw(page).rectangle((200, 300, 299, 899), fill=0)  # 100 wide, 600 long
    # The page is 1183 dots wide: Unidrv fills the spare 1184th bit of every row with black.
    ImageDraw.Draw(page).line((1183, 0, 1183, 1676), fill=0)
    rows = page.point(lambda v: 255 if v >= 128 else 0, mode="1")
    data = bytes(b ^ 0xFF for b in rows.tobytes())
    width = 148
    stream = protocol.alignment(1)
    for start in range(0, len(data), width):
        row = data[start:start + width]
        packed = lzo.compress(row)
        stream += b"\x1dv00" + width.to_bytes(2, "little") + (1).to_bytes(2, "little") + len(packed).to_bytes(4, "little") + packed
    stream += b"\x1df" + (1677).to_bytes(2, "little") + protocol.feed(10)
    job = spool.parse(stream)
    assert job.wide and not job.continuous
    fitted = job.fit_to_content(margin_mm=0)
    assert not fitted.wide and fitted.continuous
    label = fitted.labels[0]
    assert {len(r) for r in label.rows} == {12}
    # 100 × 600 block scaled to 96 dots across: about 576 dots long.
    assert abs(len(label.rows) - 576) <= 3
    assert label.feed_dots == protocol.mm_to_dots(10)
    assert spool.parse(fitted.data).labels[0].rows == label.rows


def _a5_job(boxes):
    """Driver output for the "Fit to tape (A5)" size: one page per black rectangle."""
    from PIL import Image, ImageDraw

    from qutie import lzo

    stream = protocol.alignment(1)
    for box in boxes:
        page = Image.new("L", (148 * 8, 1677), 255)
        ImageDraw.Draw(page).rectangle(box, fill=0)
        data = bytes(b ^ 0xFF for b in page.point(lambda v: 255 if v >= 128 else 0, mode="1").tobytes())
        for start in range(0, len(data), 148):
            packed = lzo.compress(data[start:start + 148])
            stream += (b"\x1dv00" + (148).to_bytes(2, "little") + (1).to_bytes(2, "little")
                       + len(packed).to_bytes(4, "little") + packed)
        stream += b"\x1df" + (1677).to_bytes(2, "little") + protocol.feed(10)
    return stream


def _inked_columns(label):
    img = label.image()
    px = img.load()
    return sum(1 for x in range(img.width) if any(px[x, y] == 0 for y in range(img.height)))


def test_same_height_option():
    # Page 1: a block 100 dots across; page 2: one 50 across (both 600 / 300 long).
    data = _a5_job([(200, 300, 299, 899), (200, 300, 249, 599)])
    same = spool.parse(data).fit_to_content(margin_mm=0, same_height=True)
    assert _inked_columns(same.labels[0]) == 96
    assert abs(_inked_columns(same.labels[1]) - 48) <= 2  # one scale: half as wide
    assert abs(len(same.labels[1].rows) - 288) <= 3
    # Same band across the tape: both blocks start at x = 200 on the page, so both
    # start at the same edge of the tape (not centred).
    first_inked = lambda label: next(x for x in range(96) if any(label.image().getpixel((x, y)) == 0 for y in range(len(label.rows))))
    assert first_inked(same.labels[0]) == first_inked(same.labels[1]) == 0
    each = spool.parse(data).fit_to_content(margin_mm=0, same_height=False)
    assert _inked_columns(each.labels[1]) == 96  # each page fills the tape
    assert abs(len(each.labels[1].rows) - 576) <= 3


def test_gap_labels_are_not_trimmed():
    img = render.text("Gap", length_mm=40)
    job = spool.parse(b"".join(protocol.job(img, length_mm=40)))
    assert job.fit_to_content() is job


def test_image_round_trip():
    img = render.text("Round trip", length_mm=40)
    job = spool.parse(b"".join(protocol.job(img, length_mm=40)))
    assert protocol.raster(job.labels[0].image()) == protocol.raster(img)
