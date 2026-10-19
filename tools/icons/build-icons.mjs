#!/usr/bin/env node
/**
 * Builds the editor's item icon set from the pack's mod jars.
 *
 *   node build-icons.mjs --mods "<path to mods folder>" [--out ../../app/public/icons] [--size 32]
 *
 * Three kinds of item come out of this:
 *
 *   flat        the model resolves to item/generated or item/handheld, so its
 *               layer0 texture IS the icon. ~62% of the pack.
 *   block       the model resolves to a block shape (cube_all, slab, stairs, ...).
 *               We composite a 2:1 isometric cube from its face textures. ~34%.
 *   placeholder builtin/entity and custom geometry — chests, beds, banners. ~4%.
 *               A flat tile; the editor shows the id beside it.
 *
 * Icons do not need to be perfect. They need to make an item recognisable in a
 * picker. Anything wonky gets caught when the book is polished in the real UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { PNG } from 'pngjs';
import { renderModel } from './render3d.mjs';

// ---------------------------------------------------------------- arguments --
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const MODS = args.mods;
const OUT = path.resolve(args.out ?? path.join(import.meta.dirname, '..', '..', 'app', 'public', 'icons'));
const SIZE = Number(args.size ?? 32);      // isometric cube canvas
const MAX_FLAT = Number(args.maxFlat ?? 64); // cap for flat sprites; most are 16
const SUPERSAMPLE = Number(args.ss ?? 4);   // rotated edges alias badly without this

if (!MODS || !fs.existsSync(MODS)) {
  console.error('usage: node build-icons.mjs --mods "<mods folder>" --vanilla "<minecraft-client.jar>" [--out <dir>] [--size 32]');
  process.exit(2);
}

// ------------------------------------------------------------------- index ---
// Jars later in the list win, matching how a resource pack overlay would resolve.
const models = new Map();    // "ns:item/foo"     -> parsed json
const textures = new Map();  // "ns:item/foo"     -> { zip, entry }

function indexJar(file) {
  let zip;
  try { zip = new AdmZip(file); } catch { return false; }
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const m = /^assets\/([^/]+)\/(models|textures)\/(.+)\.(json|png)$/.exec(e.entryName);
    if (!m) continue;
    const [, ns, kind, rest, ext] = m;
    const key = `${ns}:${rest}`;
    if (kind === 'models' && ext === 'json') {
      try { models.set(key, JSON.parse(zip.readAsText(e))); } catch { /* malformed model */ }
    } else if (kind === 'textures' && ext === 'png') {
      textures.set(key, { zip, entry: e });
    }
  }
  return true;
}

function indexJars(dir) {
  const jars = fs.readdirSync(dir).filter(f => f.endsWith('.jar')).sort();
  jars.forEach((jar, i) => {
    indexJar(path.join(dir, jar));
    if ((i + 1) % 50 === 0) process.stderr.write(`  indexed ${i + 1}/${jars.length} jars\n`);
  });
  return jars.length;
}

const norm = s => (String(s).includes(':') ? String(s) : `minecraft:${s}`);

// Walk child -> parent, collecting the texture map (child wins) and the root model.
function resolve(key, depth = 0) {
  const seen = [];
  let cur = key, tex = {}, model = null, elements = null, display = {};
  while (cur && depth++ < 16) {
    const m = models.get(cur);
    seen.push(cur);
    if (!m) break;                       // vanilla parents are not in mod jars
    model = m;
    // NeoForge's separate_transforms loader nests the real model under "base",
    // leaving the top level with no textures at all.
    tex = { ...(m.base?.textures ?? {}), ...(m.textures ?? {}), ...tex };
    // Geometry is usually inherited: cube_all declares only textures, and its
    // parent block/cube carries the box. Nearest definition wins.
    if (!elements && Array.isArray(m.elements) && m.elements.length) elements = m.elements;
    if (!elements && Array.isArray(m.base?.elements) && m.base.elements.length) elements = m.base.elements;
    display = { ...(m.display ?? {}), ...display };
    if (!m.parent) break;
    cur = norm(m.parent);
  }
  return { root: cur, chain: seen, textures: tex, model, elements, display };
}

// "#side" indirections can chain; resolve to a real ns:path.
function texRef(tex, name, depth = 0) {
  let v = tex[name];
  while (typeof v === 'string' && v.startsWith('#') && depth++ < 8) v = tex[v.slice(1)];
  return typeof v === 'string' ? norm(v) : null;
}

/** Resolves a face's '#name' reference to a namespaced texture id. */
function resolveRef(tex, ref) {
  let v = ref, guard = 0;
  while (typeof v === 'string' && v.startsWith('#') && guard++ < 8) v = tex[v.slice(1)];
  return typeof v === 'string' ? norm(v) : null;
}

// ------------------------------------------------------------------ pixels ---
/**
 * pngjs refuses any file with bytes after the IEND chunk ("unrecognised content at
 * end of stream"), and a surprising number of mod textures have them — 13 of 92 in
 * one Malum folder. The image itself is fine, so trim to the end of IEND and retry.
 */
function decodePng(buf) {
  try {
    return PNG.sync.read(buf);
  } catch (err) {
    if (!/end of stream/i.test(err.message)) throw err;
    const at = buf.lastIndexOf('IEND');
    if (at < 0) throw err;
    return PNG.sync.read(buf.subarray(0, at + 8));   // IEND + its 4-byte CRC
  }
}

const decoded = new Map();
function readTexture(ref) {
  if (!ref) return null;
  if (decoded.has(ref)) return decoded.get(ref);
  const rec = textures.get(ref);
  let img = null;
  if (rec) {
    try {
      const png = decodePng(rec.zip.readFile(rec.entry));
      // Animated textures are vertical strips of square frames; take frame 0.
      img = png.height > png.width && png.height % png.width === 0
        ? crop(png, 0, 0, png.width, png.width)
        : png;
    } catch { img = null; }
  }
  decoded.set(ref, img);
  return img;
}

function crop(src, x0, y0, w, h) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * src.width + (x0 + x)) << 2, d = (y * w + x) << 2;
      out.data[d] = src.data[s]; out.data[d + 1] = src.data[s + 1];
      out.data[d + 2] = src.data[s + 2]; out.data[d + 3] = src.data[s + 3];
    }
  return out;
}

const sample = (img, u, v) => {
  const x = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)));
  const y = Math.min(img.height - 1, Math.max(0, Math.floor(v * img.height)));
  const i = (y * img.width + x) << 2;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

function scaleTo(img, size) {
  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = sample(img, (x + 0.5) / size, (y + 0.5) / size);
      const d = (y * size + x) << 2;
      out.data[d] = r; out.data[d + 1] = g; out.data[d + 2] = b; out.data[d + 3] = a;
    }
  return out;
}

/**
 * 2:1 isometric cube. Three parallelograms, each inverse-mapped to its texture:
 * a point P inside face (O,U,V) is O + u*U + v*V, so solving the 2x2 gives the UV.
 * Faces are shaded top > left > right the way Minecraft lights an inventory block.
 */
function isoCube(top, left, right, size) {
  const S = size, h = S / 2, q = S / 4;
  const faces = [
    { O: [0, q], U: [h, -q], V: [h, q], img: top,   shade: 1.00 },
    { O: [0, q], U: [h, q],  V: [0, h], img: left,  shade: 0.72 },
    { O: [h, h], U: [h, -q], V: [0, h], img: right, shade: 0.56 },
  ];
  const out = new PNG({ width: S, height: S });
  for (const f of faces) {
    const [ux, uy] = f.U, [vx, vy] = f.V;
    const det = ux * vy - uy * vx;
    if (!det || !f.img) continue;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const px = x + 0.5 - f.O[0], py = y + 0.5 - f.O[1];
        const u = (px * vy - py * vx) / det;
        const v = (ux * py - uy * px) / det;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        const [r, g, b, a] = sample(f.img, u, v);
        if (a === 0) continue;
        const d = (y * S + x) << 2;
        out.data[d] = Math.round(r * f.shade);
        out.data[d + 1] = Math.round(g * f.shade);
        out.data[d + 2] = Math.round(b * f.shade);
        out.data[d + 3] = a;
      }
  }
  return out;
}

function placeholder(size) {
  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
      const d = (y * size + x) << 2;
      out.data[d] = edge ? 110 : 62; out.data[d + 1] = edge ? 116 : 68;
      out.data[d + 2] = edge ? 130 : 80; out.data[d + 3] = edge ? 255 : 190;
    }
  return out;
}

// ------------------------------------------------------------------- build ---
const FACE_SETS = [
  ['all', 'all', 'all'],
  ['top', 'side', 'side'], ['up', 'north', 'east'],
  ['end', 'side', 'side'], ['top', 'bottom', 'side'],
  ['top', 'wall', 'wall'], ['texture', 'texture', 'texture'],
  ['side', 'side', 'side'], ['inside', 'inside', 'inside'],
];
// Custom models (usually Blockbench exports) number their textures; "particle" is
// the block's representative texture. Either makes a far better icon than a grey tile.
const LAST_RESORT = ['0', 'particle', '1', 'bottom'];

// Vanilla first so mod jars override it. Without this, any modded model that points
// at a minecraft: texture resolves to nothing and falls through to a placeholder.
if (args.vanilla) {
  console.error(indexJar(args.vanilla)
    ? `indexed vanilla assets from ${path.basename(args.vanilla)}`
    : `WARNING: could not read ${args.vanilla}`);
} else {
  console.error('WARNING: no --vanilla client jar given; models using minecraft: textures will fall back');
}

console.error(`indexing jars in ${MODS} ...`);
const jarCount = indexJars(MODS);
console.error(`  ${jarCount} jars, ${models.size} models, ${textures.size} textures\n`);

fs.mkdirSync(OUT, { recursive: true });
const index = {};
const stats = { flat: 0, model: 0, block: 0, placeholder: 0, failed: 0 };

const itemKeys = [...models.keys()].filter(k => k.includes(':item/'));
let done = 0;

for (const key of itemKeys) {
  const [ns, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const id = `${ns}:${rest.replace(/^item\//, '')}`;
  const { textures: tex, elements, display } = resolve(key);

  let img = null, kind = null;

  // A layer0 texture is a flat sprite whatever the chain resolves to — plenty of
  // mods parent their items to their own base model rather than to item/generated.
  // Keep it at its native resolution: nearly all are 16x16, and upscaling them to
  // 32 quadruples the bytes for no extra information. The editor scales up in CSS
  // with image-rendering: pixelated.
  const flat = readTexture(texRef(tex, 'layer0'));
  if (flat) {
    img = flat.width > MAX_FLAT ? scaleTo(flat, MAX_FLAT) : flat;
    kind = 'flat';
  }

  // Real geometry: rasterize the model the way the game does. This is what makes
  // stairs look like stairs and a Create machine look like itself, rather than
  // every block collapsing to the same cube.
  if (!img && elements) {
    const rendered = renderModel(
      { elements, textures: tex, display },
      ref => readTexture(resolveRef(tex, ref)),
      SIZE, SUPERSAMPLE);
    if (rendered) {
      const p = new PNG({ width: rendered.width, height: rendered.height });
      p.data = rendered.data;
      img = p;
      kind = 'model';
    }
  }

  // No geometry anywhere in the chain: approximate with a cube of its faces.
  if (!img) {
    for (const [t, l, r] of FACE_SETS) {
      const ti = readTexture(texRef(tex, t));
      if (!ti) continue;
      img = isoCube(ti, readTexture(texRef(tex, l)) ?? ti, readTexture(texRef(tex, r)) ?? ti, SIZE);
      kind = 'block';
      break;
    }
  }

  if (!img) {
    const ref = LAST_RESORT.map(k => texRef(tex, k)).find(Boolean)
      ?? Object.keys(tex).map(k => texRef(tex, k)).find(Boolean);
    const ti = readTexture(ref);
    if (ti) { img = isoCube(ti, ti, ti, SIZE); kind = 'block'; }
  }

  if (!img) { img = placeholder(SIZE); kind = 'placeholder'; }

  const rel = path.join(ns, `${rest.replace(/^item\//, '').replace(/\//g, '__')}.png`);
  fs.mkdirSync(path.join(OUT, ns), { recursive: true });
  try {
    fs.writeFileSync(path.join(OUT, rel), PNG.sync.write(img, { deflateLevel: 9 }));
    index[id] = { file: rel.replace(/\\/g, '/'), kind, w: img.width, h: img.height };
    stats[kind]++;
  } catch { stats.failed++; }

  if (++done % 2000 === 0) process.stderr.write(`  ${done}/${itemKeys.length}\n`);
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  generated: new Date().toISOString(), size: SIZE, count: Object.keys(index).length, icons: index
}, null, 0));

console.error('\ndone');
for (const [k, v] of Object.entries(stats)) console.error(`  ${k.padEnd(12)} ${v}`);
console.error(`  -> ${OUT}`);
