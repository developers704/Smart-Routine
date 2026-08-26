import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(size, paint) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x, y, size);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function inRoundRect(x, y, s, m, r) {
  const x0 = m;
  const y0 = m;
  const x1 = s - m;
  const y1 = s - m;
  if (x >= x0 + r && x < x1 - r && y >= y0 && y < y1) return true;
  if (y >= y0 + r && y < y1 - r && x >= x0 && x < x1) return true;
  const corners = [
    [x0 + r, y0 + r],
    [x1 - r, y0 + r],
    [x0 + r, y1 - r],
    [x1 - r, y1 - r],
  ];
  return corners.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
}

function paint(x, y, s) {
  const m = Math.round(s * 0.08);
  const r = Math.round(s * 0.16);
  if (!inRoundRect(x, y, s, m, r)) return [251, 244, 246, 255];
  const inner = inRoundRect(x, y, s, m + Math.round(s * 0.06), Math.round(s * 0.1));
  if (!inner) return [196, 91, 120, 255];
  const top = y < s * 0.42;
  if (top) return [255, 250, 251, 255];
  const cx = s * 0.38;
  const cy = s * 0.62;
  const d = Math.hypot(x - cx, y - cy);
  if (d < s * 0.07) return [196, 91, 120, 255];
  const cx2 = s * 0.55;
  if (Math.hypot(x - cx2, y - cy) < s * 0.07) return [95, 157, 134, 255];
  return [255, 250, 251, 255];
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client", "icons");
for (const size of [180, 192, 512]) {
  writeFileSync(path.join(dir, `icon-${size}.png`), png(size, paint));
}
console.log("wrote icons 180/192/512");
