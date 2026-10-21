#!/usr/bin/env node
/**
 * Pulls a handful of GUI sprites out of the Minecraft client jar, so the editor's
 * recipe view can look like the game's rather than like a web form.
 *
 *   node build-ui.mjs --vanilla "<minecraft-client.jar>"
 *
 * Two kinds of source. Since 1.20.5 most widgets are their own sprite files and
 * come out whole. The container backgrounds are still single 256x256 sheets, so
 * the slot and the crafting arrow are cropped out of one by coordinate — the same
 * coordinates the game's own screen code blits from.
 *
 * Output goes to `app/public/icons/ui/`, beside the item icons, and like them it
 * is derived from a jar rather than committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const VANILLA = args.vanilla;
const OUT = path.resolve(args.out
  ?? path.join(import.meta.dirname, '..', '..', 'app', 'public', 'icons', 'ui'));

if (!VANILLA || !fs.existsSync(VANILLA)) {
  console.error('usage: node build-ui.mjs --vanilla "<minecraft-client.jar>"');
  process.exit(2);
}

const G = 'assets/minecraft/textures/gui/';

/** Whole sprite files, taken as they are. */
const WHOLE = {
  'flame.png': G + 'sprites/container/furnace/lit_progress.png',
  'cook_arrow.png': G + 'sprites/container/furnace/burn_progress.png',
  'blast_arrow.png': G + 'sprites/container/blast_furnace/burn_progress.png',
  'slot_disabled.png': G + 'sprites/container/crafter/disabled_slot.png',
};

/** [source sheet, x, y, w, h] — the blits the vanilla screens make. */
const CROPS = {
  'slot.png': [G + 'container/crafting_table.png', 28, 15, 18, 18],
  'arrow.png': [G + 'container/crafting_table.png', 89, 34, 24, 17],
  'furnace_slot.png': [G + 'container/furnace.png', 55, 52, 18, 18],
};

const zip = new AdmZip(VANILLA);
fs.mkdirSync(OUT, { recursive: true });
let n = 0;

for (const [name, entry] of Object.entries(WHOLE)) {
  const e = zip.getEntry(entry);
  if (!e) { console.warn('missing', entry); continue; }
  fs.writeFileSync(path.join(OUT, name), zip.readFile(e));
  n++;
}

for (const [name, [entry, x, y, w, h]] of Object.entries(CROPS)) {
  const e = zip.getEntry(entry);
  if (!e) { console.warn('missing', entry); continue; }
  const src = PNG.sync.read(zip.readFile(e));
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, x, y, w, h, 0, 0);
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(out));
  n++;
}

console.log(`${n} gui sprites -> ${OUT}`);
