#!/usr/bin/env node
/**
 * Checks that a candidate wiki is actually about the mod it was matched to.
 *
 * Guessing hostnames finds real wikis and also finds `spawn.fandom.com`, which
 * is about a comic book. Attaching that to a Minecraft item would be worse than
 * having no documentation at all, so every host has to earn its place: pull a
 * few hundred page titles and count how many are names of items that mod
 * actually registers.
 *
 * A wrong wiki scores zero or close to it. A right one scores dozens.
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ICONS = path.join(HERE, '..', '..', 'app', 'public', 'icons');
const UA = 'DragonscaleQuestEditor/0.1 (private modpack documentation tooling)';
const MIN_HITS = 5;

const names = JSON.parse(fs.readFileSync(path.join(ICONS, 'names.json'), 'utf8')).names;
const wikis = JSON.parse(fs.readFileSync(path.join(HERE, 'wikis.json'), 'utf8')).wikis;

const byNs = {};
for (const [id, name] of Object.entries(names)) {
  const ns = id.slice(0, id.indexOf(':'));
  (byNs[ns] ??= new Set()).add(name.toLowerCase().trim());
}

async function titles(host, limit = 500) {
  try {
    const r = await fetch(`https://${host}/api.php?action=query&list=allpages&aplimit=${limit}&apfilterredir=nonredirects&format=json`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return (j?.query?.allpages ?? []).map(p => p.title);
  } catch {
    return [];
  }
}

const kept = {};
for (const [ns, w] of Object.entries(wikis)) {
  const want = byNs[ns];
  if (!want) { console.log(`  skip ${ns}: no item names`); continue; }
  const list = await titles(w.host);
  const hits = list.filter(t => want.has(t.toLowerCase().trim()));
  const verdict = hits.length >= MIN_HITS ? 'KEEP' : 'drop';
  console.log(`  ${verdict}  ${ns.padEnd(20)} ${w.host.padEnd(30)} ${hits.length} of ${list.length} titles are its items`
    + (hits.length ? `  e.g. ${hits.slice(0, 3).join(', ')}` : ''));
  if (hits.length >= MIN_HITS) kept[ns] = { ...w, verified: hits.length };
}

fs.writeFileSync(path.join(HERE, 'wikis.json'),
  JSON.stringify({ verified: new Date().toISOString(), wikis: kept }, null, 1));
console.log(`\n${Object.keys(kept).length} verified, ${Object.keys(wikis).length - Object.keys(kept).length} rejected`);
