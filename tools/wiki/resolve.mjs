#!/usr/bin/env node
/**
 * Finds where each mod's documentation actually lives, by asking Modrinth.
 *
 *   node resolve.mjs
 *
 * Guessing wiki hostnames found four wikis. Modrinth's API carries the answer
 * directly — every project record has `wiki_url` and `source_url` as the author
 * set them — and it needs no key and no rate-limit gymnastics. That turns up
 * official wikis the guessing never would: wiki.createmod.net rather than the
 * Fandom mirror, quarkmod.net, GitHub wikis.
 *
 * It also keeps `body`, the project description, which for a lot of mods is a
 * genuine feature list written by the author and is the best documentation that
 * mod will ever have.
 *
 * Writes `sources.json`: mod id -> { slug, wiki, source, body }.
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ICONS = path.join(HERE, '..', '..', 'app', 'public', 'icons');
const OUT = path.join(HERE, 'sources.json');
const UA = 'DragonscaleQuestEditor/0.1 (private modpack documentation tooling)';
const args = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--')).map(a => [a.slice(2), true]));

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function json(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Slug first — it is usually the mod id or its name — then search by name. */
async function find(id, name) {
  const slugs = [...new Set([
    id.replace(/_/g, '-'),
    id,
    (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  ])].filter(Boolean);

  for (const slug of slugs) {
    const p = await json(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}`);
    if (p && p.slug) return p;
    await sleep(120);
  }
  const s = await json(`https://api.modrinth.com/v2/search?limit=3&query=${encodeURIComponent(name || id)}`);
  for (const hit of s?.hits ?? []) {
    // Only trust a search hit whose title really is this mod, not something near it.
    const a = (hit.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const b = (name || id).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (a === b || a.startsWith(b) || b.startsWith(a)) {
      const p = await json(`https://api.modrinth.com/v2/project/${hit.project_id}`);
      if (p && p.slug) return p;
    }
  }
  return null;
}

const out = {};
let found = 0, wikis = 0, repos = 0;
for (const [id, mod] of targets) {
  const p = await find(id, mod.name);
  if (!p) { console.log(`  ---  ${id}`); continue; }
  found++;
  if (p.wiki_url) wikis++;
  if (p.source_url) repos++;
  out[id] = {
    slug: p.slug, title: p.title, items: itemCount[id] || 0,
    wiki: p.wiki_url || '', source: p.source_url || '',
    body: p.body || '', summary: p.description || '',
  };
  console.log(`  ${String(itemCount[id] || 0).padStart(5)} ${id.padEnd(24)}`
    + ` ${(p.wiki_url ? 'W' : '-')}${(p.source_url ? 'S' : '-')}`
    + ` ${(p.wiki_url || p.source_url || '').slice(0, 60)}`);
  await sleep(140);
}

fs.writeFileSync(OUT, JSON.stringify({ resolved: new Date().toISOString(), sources: out }, null, 1));
console.log(`\n${found} of ${targets.length} mods found on Modrinth`);
console.log(`  ${wikis} with a wiki link, ${repos} with a source repo`);
console.log(`  -> ${OUT}`);
