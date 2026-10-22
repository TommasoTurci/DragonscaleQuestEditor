#!/usr/bin/env node
/**
 * Combines everything harvested into the one file the editor loads.
 *
 *   node merge.mjs
 *
 * Output is `app/public/icons/docs.json`: item id -> { text, src, wiki }. It
 * sits beside the icons and names because it is the same kind of thing — derived
 * from somewhere else, regenerable, and not worth committing.
 *
 * Non-item pages are kept too, under `topics`, keyed by mod. A wiki's page on
 * Stress or on Contraptions is not an item but it is exactly the sort of thing
 * someone writing a tutorial quest needs to hand.
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const IN = path.join(HERE, 'harvested');
const OUT = path.join(HERE, '..', '..', 'app', 'public', 'icons', 'docs.json');

const docs = {};
const topics = {};
const sources = {};

for (const file of fs.readdirSync(IN).filter(f => f.endsWith('.json'))) {
  const j = JSON.parse(fs.readFileSync(path.join(IN, file), 'utf8'));
  sources[j.ns] = { wiki: j.wiki, harvested: j.harvested, items: 0, topics: 0 };
  for (const [id, d] of Object.entries(j.docs ?? {})) {
    docs[id] = { text: d.text, src: d.src, wiki: j.wiki };
    sources[j.ns].items++;
  }
  // Vanilla's wiki covers the whole game, so its non-item pages are thousands of
  // tutorials and version histories. Only the modest per-mod sets are worth it.
  const orphans = Object.entries(j.orphans ?? {});
  if (orphans.length <= 400) {
    for (const [title, d] of orphans) {
      (topics[j.ns] ??= {})[title] = { text: d.text, src: d.src };
      sources[j.ns].topics++;
    }
  }
}

fs.writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  count: Object.keys(docs).length,
  sources, docs, topics,
}));

const size = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`${Object.keys(docs).length} documented items, `
  + `${Object.values(topics).reduce((a, t) => a + Object.keys(t).length, 0)} topic pages`);
for (const [ns, s] of Object.entries(sources).sort((a, b) => b[1].items - a[1].items)) {
  console.log(`  ${String(s.items).padStart(4)} ${ns.padEnd(18)} ${s.wiki}`);
}
console.log(`  -> ${OUT} (${size} MB)`);
