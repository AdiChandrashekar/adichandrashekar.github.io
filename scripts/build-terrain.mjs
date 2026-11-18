#!/usr/bin/env node
// Bakes real elevation data into small heightmaps for the contour backdrop.
// Source: open Terrarium terrain tiles (Mapzen / AWS Open Data, derived from SRTM and others).
// Output: data/terrain/<slug>.bin (Int16 metres, negative = below sea level, row-major) + data/terrain/index.json.
// Run once, or when adding a location: `node scripts/build-terrain.mjs`.

import { writeFile, mkdir } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "data", "terrain");

const LOCATIONS = [
  { slug: "nanda-devi", label: "Nanda Devi, Garhwal Himalaya", lat: 30.376, lon: 79.971, z: 11 },
  { slug: "nilgiris", label: "Nilgiri Hills, Western Ghats", lat: 11.38, lon: 76.75, z: 11 },
  { slug: "darjeeling", label: "Darjeeling Hills", lat: 27.03, lon: 88.27, z: 11 },
  { slug: "mount-abu", label: "Mount Abu, Aravalli Range", lat: 24.6, lon: 72.72, z: 12 },
  { slug: "chennai", label: "Chennai and the Bay of Bengal", lat: 13.06, lon: 80.19, z: 11, bathymetry: true, scale: "sqrt" },
];

const TILES_X = 4;   // 4 x 3 tiles of 256 px
const TILES_Y = 3;
const DOWNSAMPLE = 4; // -> 256 x 192 samples

// ---------- Minimal PNG decoder (8-bit RGB / RGBA, non-interlaced) ----------
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG");
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error("unsupported colour type " + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, bpp, pixels: out };
}

function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
}

async function bake(loc) {
  const [cx, cy] = tileXY(loc.lat, loc.lon, loc.z);
  const x0 = Math.round(cx - TILES_X / 2);
  const y0 = Math.round(cy - TILES_Y / 2);
  const W = TILES_X * 256, H = TILES_Y * 256;
  const full = new Float32Array(W * H);

  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${loc.z}/${x0 + tx}/${y0 + ty}.png`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
      const png = decodePng(Buffer.from(await res.arrayBuffer()));
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          const i = (y * 256 + x) * png.bpp;
          const p = png.pixels;
          const h = p[i] * 256 + p[i + 1] + p[i + 2] / 256 - 32768;
          full[(ty * 256 + y) * W + tx * 256 + x] = h;
        }
      }
    }
  }

  // Coastal locations: the z11+ tiles carry no sea depths (the sea reads 0 m), so
  // fill sea pixels from the coarser z10 tiles, which include bathymetry.
  if (loc.bathymetry) {
    const zb = 10, f = 2 ** (loc.z - zb);
    const cache = new Map();
    const tileAt = async (tx, ty) => {
      const key = tx + "/" + ty;
      if (!cache.has(key)) {
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zb}/${tx}/${ty}.png`;
        const png = decodePng(Buffer.from(await (await fetch(url)).arrayBuffer()));
        const a = new Float32Array(256 * 256);
        for (let i = 0; i < a.length; i++) {
          const p = png.pixels, j = i * png.bpp;
          a[i] = p[j] * 256 + p[j + 1] + p[j + 2] / 256 - 32768;
        }
        cache.set(key, a);
      }
      return cache.get(key);
    };
    const coarse = async (gx, gy) => { // global z10 pixel coords, nearest
      const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
      const t = await tileAt(tx, ty);
      return t[(Math.floor(gy) - ty * 256) * 256 + (Math.floor(gx) - tx * 256)];
    };
    const bilinear = async (gx, gy) => {
      const x = Math.floor(gx - 0.5), y = Math.floor(gy - 0.5), fx = gx - 0.5 - x, fy = gy - 0.5 - y;
      const a = await coarse(x, y), b = await coarse(x + 1, y), c = await coarse(x, y + 1), d = await coarse(x + 1, y + 1);
      return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (full[i] > 0) continue;
        const v = await bilinear((x0 * 256 + x + 0.5) / f, (y0 * 256 + y + 0.5) / f);
        full[i] = Math.min(-1, v); // below sea level, at least just
      }
    }
  }

  // Box-filter downsample
  const w = W / DOWNSAMPLE, h = H / DOWNSAMPLE;
  const out = new Int16Array(w * h);
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < DOWNSAMPLE; dy++)
        for (let dx = 0; dx < DOWNSAMPLE; dx++) s += full[(y * DOWNSAMPLE + dy) * W + x * DOWNSAMPLE + dx];
      const v = Math.max(-32768, Math.min(32767, Math.round(s / (DOWNSAMPLE * DOWNSAMPLE))));
      out[y * w + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  await writeFile(join(outDir, `${loc.slug}.bin`), Buffer.from(out.buffer));
  console.log(`  ${loc.slug}: ${w}x${h}, ${min}–${max} m`);
  return { slug: loc.slug, label: loc.label, lat: loc.lat, lon: loc.lon, z: loc.z, scale: loc.scale || "linear", width: w, height: h, min, max };
}

await mkdir(outDir, { recursive: true });
const only = process.argv[2];
const prev = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(join(outDir, "index.json"), "utf8")).catch(() => '{"locations":[]}'));
const index = [];
for (const loc of LOCATIONS) {
  const old = prev.locations.find((l) => l.slug === loc.slug);
  index.push(only && loc.slug !== only && old ? old : await bake(loc));
}
await writeFile(
  join(outDir, "index.json"),
  JSON.stringify({ source: "Terrarium terrain tiles (AWS Open Data)", locations: index }, null, 2) + "\n"
);
console.log("  wrote data/terrain/index.json");
