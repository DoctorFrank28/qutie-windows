// The Qutie's commands and the bytes of a label: a port of src/qutie/protocol.py.
// A label goes to the head as rows of 96 dots (12 bytes, most significant bit on the left,
// 1 = black), in GS v 0 0 blocks of 60 rows, each an LZO1X literal run.

const ESC = 0x1b, GS = 0x1d;
const HEAD_DOTS = 96, ROW_BYTES = 12, PACKET = 720;
const DOTS_PER_MM = 203 / 25.4;
const FEED_MM = 14; // the feed of the app's "feed" button, and after continuous tape
const EXTRA_MM = 10; // after a gap label: with GS f alone its end stays under the cutter

const mmToDots = (mm) => Math.floor(mm * DOTS_PER_MM + 1e-6);
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

const COMMANDS = {
  status: () => new Uint8Array([ESC, 0x12, 0x73]), // reply: 17 bytes
  info: () => new Uint8Array([ESC, 0x12, 0x64]), // reply: 143 bytes
  alignment: (n = 1) => new Uint8Array([ESC, 0x61, n]),
  endOfLabel: (mm) => new Uint8Array([GS, 0x66, ...le16(mmToDots(mm))]),
  feed: (mm = FEED_MM) => new Uint8Array([ESC, ESC, 1, ...le16(mmToDots(mm))]),
  density: (n) => new Uint8Array([GS, 0x73, 0x65, 0x74, 0x63, Math.max(0, Math.min(255, Math.round(n)))]), // GS "setc" n
  autoOff: (minutes) => new Uint8Array([GS, 0x73, 0x65, 0x74, 0x74, ...le16(Math.round(minutes * 60))]), // GS "sett" seconds
};

/** A single LZO1X literal run: valid LZO1X, and what the printer decompresses (lzo.py). */
function lzoLiterals(data) {
  const n = data.length;
  let head;
  if (n === 0) return new Uint8Array([0x11, 0, 0]);
  if (n <= 238) head = [n + 17];
  else {
    let zeros = Math.floor((n - 18) / 255), last = (n - 18) % 255;
    if (last === 0) { zeros -= 1; last = 255; }
    head = [0, ...new Array(zeros).fill(0), last];
  }
  const out = new Uint8Array(head.length + n + 3);
  out.set(head);
  out.set(data, head.length);
  out.set([0x11, 0, 0], head.length + n);
  return out;
}

/**
 * The head's rows for a label drawn as read ({width, height: 96, bits}, bits[y·width + x] = 1
 * for black), turned a quarter clockwise so the start of the label comes out first.
 */
function headRows(raster) {
  const L = raster.width, bits = raster.bits;
  if (raster.height !== HEAD_DOTS) throw new Error(`a label is ${HEAD_DOTS} dots high, not ${raster.height}`);
  const out = new Uint8Array(L * ROW_BYTES);
  for (let y = 0; y < L; y++) { // printed row y = label column y
    for (let x = 0; x < HEAD_DOTS; x++) { // printed column x = label row 95 − x
      if (bits[(HEAD_DOTS - 1 - x) * L + y]) out[y * ROW_BYTES + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** GS v 0 0 blocks: width in bytes (2), rows (2), LZO length (4), LZO data. */
function rasterBlocks(rows) {
  const blocks = [];
  for (let start = 0; start < rows.length; start += PACKET) {
    const chunk = rows.subarray(start, start + PACKET);
    const packed = lzoLiterals(chunk);
    const head = [GS, 0x76, 0x30, 0x30, ...le16(ROW_BYTES), ...le16(chunk.length / ROW_BYTES), ...le32(packed.length)];
    const block = new Uint8Array(head.length + packed.length);
    block.set(head);
    block.set(packed, head.length);
    blocks.push(block);
  }
  return blocks;
}

/**
 * Every write that prints one label (as protocol.job and the Studio's label_job).
 * media: {type: "gap" | "continuous", length_mm, feed_mm}.
 */
function labelJob(raster, media = {}) {
  const gap = media.type !== "continuous";
  const feed = Number(media.feed_mm ?? (gap ? EXTRA_MM : FEED_MM));
  const writes = [COMMANDS.alignment(1), ...rasterBlocks(headRows(raster))];
  if (gap) {
    writes.push(COMMANDS.endOfLabel(Number(media.length_mm) || raster.width / DOTS_PER_MM));
    if (feed > 0) writes.push(COMMANDS.feed(feed));
  } else writes.push(COMMANDS.feed(feed));
  return writes;
}

const asciiText = (bytes) => new TextDecoder("latin1").decode(bytes).replace(/[\0\xff]+$/g, "").replace(/[^\x20-\x7e]/g, "").trim();

/** The 17-byte status reply. */
function parseStatus(b) {
  if (b.length < 8) throw new Error(`status reply too short (${b.length} bytes)`);
  return {
    code: Number(`${b[1]}${b[0]}`),
    battery: b[3],
    autoOffMinutes: Math.floor((b[4] | (b[5] << 8)) / 60),
    density: b[6],
    paper: b[7] === 0 ? "continuous" : "gap",
    paperType: b[7],
  };
}

/** The 143-byte info reply. */
function parseInfo(b) {
  if (b.length < 124) throw new Error(`info reply too short (${b.length} bytes)`);
  return {
    model: asciiText(b.subarray(32, 56)).replace(/[^A-Za-z0-9 -]/g, ""),
    serial: asciiText(b.subarray(56, 88)),
    firmware: `${b[88]}.${b[89]}.${b[90]}`,
    board: `${b[91]}.${String(b[92]).padStart(2, "0")}.${String(b[93]).padStart(2, "0")}`,
    bluetooth: asciiText(b.subarray(112, 124)),
  };
}
