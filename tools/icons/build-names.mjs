#!/usr/bin/env node
/**
 * Builds the editor's item name table from the pack's mod jars.
 *
 *   node build-names.mjs --mods "<mods folder>" --vanilla "<minecraft-client.jar>"
 *
 * The editor showed raw ids — `another_furniture:oak_bench` — because a dedicated
 * server has no language file loaded and cannot tell you an item is called "Oak
 * Bench". Nobody composes a quest book by reading registry ids, so the names come
 * from where the icons already come from: `assets/<ns>/lang/en_us.json` inside
 * every jar, which is the same table the game itself reads.
 *
 * Output is `names.json` beside `index.json`, mapping item id to display name.
 * Like the icons it is derived from the jars, so it is not committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const MODS = args.mods;
const VANILLA = args.vanilla;
const OUT = path.resolve(args.out ?? path.join(import.meta.dirname, '..', '..', 'app', 'public', 'icons'));

if (!MODS || !fs.existsSync(MODS)) {
  console.error('usage: node build-names.mjs --mods "<mods folder>" --vanilla "<client.jar>"');
  process.exit(2);
}

const jars = [
  ...(VANILLA && fs.existsSync(VANILLA) ? [VANILLA] : []),
  ...fs.readdirSync(MODS).filter(f => f.endsWith('.jar')).map(f => path.join(MODS, f)),
];
if (!VANILLA) console.warn('no --vanilla: every vanilla item will keep its raw id');

/**
 * Lang keys are `item.<namespace>.<path>` and `block.<namespace>.<path>`, with
 * the path's slashes flattened to dots. Going the other way is ambiguous in
 * principle, but item ids have no dots in practice, so the first two segments
 * are the namespace and the rest is the path.
 */
const names = {};
let files = 0;

for (const jar of jars) {
  let zip;
  try { zip = new AdmZip(jar); } catch { continue; }
  for (const entry of zip.getEntries()) {
    const m = /^assets\/([a-z0-9_.-]+)\/lang\/en_us\.json$/.exec(entry.entryName);
    if (!m) continue;
    files++;
    let table;
    try { table = JSON.parse(zip.readAsText(entry)); } catch { continue; }
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== 'string') continue;
      // The namespace excludes dots on purpose: the path may contain them (a
      // flattened slash) and a greedy namespace would eat the first segments of
      // a nested path like item.mymod.tools.hammer.
      const k = /^(item|block)\.([a-z0-9_-]+)\.(.+)$/.exec(key);
      if (!k) continue;
      const id = k[2] + ':' + k[3].replace(/\./g, '/');
      // An item key beats a block key for the same id: a block item is named by
      // its block, but where a mod gives both, the item one is the one shown.
      if (k[1] === 'item' || !(id in names)) names[id] = value;
    }
  }
}

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'names.json');
fs.writeFileSync(file, JSON.stringify({ generated: new Date().toISOString(),
  count: Object.keys(names).length, names }));

const indexed = fs.existsSync(path.join(OUT, 'index.json'))
  ? Object.keys(JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8')).icons).length
  : 0;
const named = indexed
  ? Object.keys(JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8')).icons)
      .filter(id => names[id]).length
  : 0;

console.log(`${Object.keys(names).length} names from ${files} lang files in ${jars.length} jars`);
if (indexed) {
  console.log(`  ${named} of ${indexed} icons have one (${(100 * named / indexed).toFixed(1)}%)`);
}
console.log(`  -> ${file}`);
