#!/usr/bin/env node
/**
 * Finds which of the pack's mods have a MediaWiki anybody can harvest.
 *
 *   node probe.mjs            # every mod that contributes items
 *   node probe.mjs --all      # including libraries, which never have one
 *
 * Guessing hostnames is crude, but Fandom's naming is predictable enough that a
 * handful of candidates per mod finds most of what exists, and a wiki that does
 * not answer `api.php` could not be harvested anyway. Mods with no hit here are
 * the ones to look for by hand.
 *
 * Writes `wikis.json`: mod id -> host, ready for harvest.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--')).map(a => [a.slice(2), true]));
const ICONS = path.join(import.meta.dirname, '..', '..', 'app', 'public', 'icons');
const OUT = path.join(import.meta.dirname, 'wikis.json');
const UA = 'DragonscaleQuestEditor/0.1 (private modpack documentation tooling)';

const icons = JSON.parse(fs.readFileSync(path.join(ICONS, 'index.json'), 'utf8')).icons;
const mods = JSON.parse(fs.readFileSync(path.join(ICONS, 'mods.json'), 'utf8')).mods;

const itemCount = {};
for (const id of Object.keys(icons)) {
  const ns = id.slice(0, id.indexOf(':'));
  itemCount[ns] = (itemCount[ns] || 0) + 1;
}

const targets = Object.entries(mods)
  .filter(([id]) => args.all || itemCount[id])
  .sort((a, b) => (itemCount[b[0]] || 0) - (itemCount[a[0]] || 0));

/** Hostnames worth a try, from the mod's id and its display name. */
function candidates(id, name) {
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const bare = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const n = name || id;
  return [...new Set([
    `${slug(id)}.fandom.com`,
    `${bare(id)}.fandom.com`,
    `${slug(n)}.fandom.com`,
    `${bare(n)}.fandom.com`,
    `${slug(n)}-mod.fandom.com`,
    `${slug(id)}-mod.fandom.com`,
    `${slug(id)}.wiki.gg`,
    `${bare(id)}.wiki.gg`,
  ])].filter(h => h.length > 12);
}

async function alive(host) {
  const url = `https://${host}/api.php?action=query&list=allpages&aplimit=1&format=json`;
  try {
    const ctl = AbortSignal.timeout(8000);
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl });
    if (!r.ok) return 0;
    const j = await r.json();
    const pages = j?.query?.allpages;
    if (!Array.isArray(pages)) return 0;
    // A Fandom placeholder wiki answers but has nothing in it.
    const all = await fetch(`https://${host}/api.php?action=query&list=allpages&aplimit=500&format=json`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    const aj = await all.json();
    return (aj?.query?.allpages ?? []).length;
  } catch {
    return 0;
  }
}

const found = {};
let checked = 0;
for (const [id, mod] of targets) {
  checked++;
  for (const host of candidates(id, mod.name)) {
    const n = await alive(host);
    if (n >= 15) {                     // fewer than that is an empty shell
      found[id] = { host, pages: n, items: itemCount[id] || 0, name: mod.name };
      console.log(`  ${String(itemCount[id] || 0).padStart(5)} ${id.padEnd(24)} ${host} (${n}+ pages)`);
      break;
    }
  }
  if (checked % 20 === 0) process.stderr.write(`\r  ...${checked}/${targets.length} mods probed\n`);
}

fs.writeFileSync(OUT, JSON.stringify({ probed: new Date().toISOString(), wikis: found }, null, 1));
console.log(`\n${Object.keys(found).length} wikis found across ${targets.length} mods -> ${OUT}`);
