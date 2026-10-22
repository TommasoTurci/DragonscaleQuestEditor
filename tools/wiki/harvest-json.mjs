#!/usr/bin/env node
/**
 * Harvests a documentation site that publishes a search index.
 *
 *   node harvest-json.mjs --url https://iron.wiki/assets/js/data/search.json \
 *                         --ns irons_spellbooks --base https://iron.wiki
 *
 * Jekyll themes like Chirpy ship `search.json`: every page, with its title and
 * its full text, in one file. That is the entire wiki in a single request, no
 * crawling and no HTML parsing, and the join to items is the same one used
 * everywhere else — the page title against the item's display name.
 *
 * Any site with an index of `[{title, content, url}]` works; the field names can
 * be overridden if one differs.
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ICONS = path.join(HERE, '..', '..', 'app', 'public', 'icons');
const OUT = path.join(HERE, 'harvested');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
  return a;
}, []));

const { url: URL_, ns: NS, base: BASE = '' } = args;
const F_TITLE = args.title ?? 'title';
const F_TEXT = args.text ?? 'content';
const F_URL = args.link ?? 'url';

if (!URL_ || !NS) {
  console.error('usage: node harvest-json.mjs --url <search.json> --ns <namespace> [--base <site>]');
  process.exit(2);
}

const names = JSON.parse(fs.readFileSync(path.join(ICONS, 'names.json'), 'utf8')).names;
const want = new Map();
for (const [id, name] of Object.entries(names)) {
  if (id.slice(0, id.indexOf(':')) !== NS) continue;
  const key = name.toLowerCase().trim();
  if (!want.has(key)) want.set(key, id);
}

const res = await fetch(URL_, {
  headers: { 'User-Agent': 'DragonscaleQuestEditor/0.1 (private modpack documentation tooling)' },
});
const index = await res.json();
const rows = Array.isArray(index) ? index : (index.docs ?? index.entries ?? []);

/** These indexes carry rendered HTML fragments; strip them back to prose. */
const clean = s => String(s ?? '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const docs = {}, orphans = {};
for (const row of rows) {
  const title = clean(row[F_TITLE]);
  let text = clean(row[F_TEXT]);
  if (!title || text.length < 40) continue;
  if (text.length > 600) text = text.slice(0, 600).replace(/\s+\S*$/, '') + '…';
  const src = row[F_URL] ? (String(row[F_URL]).startsWith('http') ? row[F_URL] : BASE + row[F_URL]) : BASE;
  const id = want.get(title.toLowerCase());
  if (id) docs[id] = { text, src, title };
  else orphans[title] = { text, src };
}

fs.mkdirSync(OUT, { recursive: true });
const host = (BASE || URL_).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
fs.writeFileSync(path.join(OUT, `${NS}.json`), JSON.stringify({
  wiki: host, ns: NS, harvested: new Date().toISOString(),
  matched: Object.keys(docs).length, unmatched: Object.keys(orphans).length,
  docs, orphans,
}, null, 1));

console.log(`${host} -> ${NS}: ${rows.length} entries, ${Object.keys(docs).length} matched items,`
  + ` ${Object.keys(orphans).length} topics`);
