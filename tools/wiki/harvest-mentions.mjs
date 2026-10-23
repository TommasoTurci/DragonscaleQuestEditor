#!/usr/bin/env node
/**
 * Reads prose pages and works out which items they are talking about.
 *
 *   node harvest-mentions.mjs
 *
 * Several of these wikis are real wikis with real writing in them, but they are
 * organised as essays rather than as a page per item — a Starcatcher page about
 * constellations that explains six items in passing, a Spawn page describing how
 * a block is used. Title matching finds nothing in those, which is why they
 * harvested to zero.
 *
 * So instead: take every page already collected as a topic, look for item names
 * occurring in the text, and keep the sentences around each mention. That is
 * extraction, not interpretation — the words are the wiki's, and the only thing
 * being decided is which item they are about.
 *
 * The decision is kept deliberately cautious, because a wrong attribution here
 * is a sentence about the wrong block sitting in someone's quest notes:
 *
 *   - names of fewer than 7 characters, or a single short word, are skipped;
 *     "Core", "Ring" and "Pipe" appear in prose constantly and mean nothing
 *   - matching is case-sensitive and on word boundaries
 *   - the longest matching name wins, so "Blaze Burner" beats "Burner"
 *   - a mention only counts if its sentence says something beyond the name
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ICONS = path.join(HERE, '..', '..', 'app', 'public', 'icons');
const IN = path.join(HERE, 'harvested');
const OUT = path.join(IN, '_mentions.json');

const names = JSON.parse(fs.readFileSync(path.join(ICONS, 'names.json'), 'utf8')).names;
const sources = fs.existsSync(path.join(HERE, 'sources.json'))
  ? JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8')).sources : {};

/** Item names per namespace, longest first so the most specific match wins. */
const byNs = {};
for (const [id, name] of Object.entries(names)) {
  const ns = id.slice(0, id.indexOf(':'));
  const n = name.trim();
  // Too short or too generic to identify an item from prose.
  if (n.length < 7 || !/\s/.test(n)) continue;
  (byNs[ns] ??= []).push([n, id]);
}
for (const list of Object.values(byNs)) list.sort((a, b) => b[0].length - a[0].length);

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The sentences around a mention, trimmed to something readable. */
function around(text, name) {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const hit = new RegExp(`\\b${escape(name)}\\b`);
  for (let i = 0; i < sentences.length; i++) {
    if (!hit.test(sentences[i])) continue;
    let out = sentences[i].trim();
    // One more sentence if the first is mostly just the name.
    if (out.length < 110 && sentences[i + 1]) out += ' ' + sentences[i + 1].trim();
    if (out.length < 60) continue;
    return out.length > 500 ? out.slice(0, 500).replace(/\s+\S*$/, '') + '…' : out;
  }
  return '';
}

/**
 * Is this sentence actually about the item, or does it merely contain its name?
 *
 * Two things fail that test and both were in the first run. A sentence that is
 * a list — "These include the Redstone Contact, Redstone Link, Linked
 * Controller, ..." — names eight items and describes none, and attaching it to
 * all eight is worse than attaching nothing. And a project page's credits and
 * badges are markdown, not prose.
 */
function worthKeeping(quote, name, list) {
  if (quote.includes("](http") || quote.includes("![") || quote.includes("http://") || quote.includes("https://")) return false;
  if (/permission|credit|thanks to|discord|patreon|licen[cs]e/i.test(quote)) return false;

  // A sentence naming several other items is an index entry, not a description.
  let others = 0;
  for (const [other] of list) {
    if (other === name) continue;
    if (quote.includes(other)) others++;
    if (others >= 3) return false;
  }
  // It has to say something past the name itself.
  const rest = quote.replace(new RegExp(escape(name), 'g'), ' ').replace(/s+/g, ' ').trim();
  return rest.length >= 55;
}

const found = {};
let pages = 0;

function mine(ns, title, text, src) {
  const list = byNs[ns];
  if (!list || !text) return;
  pages++;
  const taken = new Set();
  for (const [name, id] of list) {
    if (found[id]) continue;                       // a page-level match already won
    if (!new RegExp(`\\b${escape(name)}\\b`).test(text)) continue;
    // Do not let "Blaze Burner" also credit "Burner" from the same sentence.
    if ([...taken].some(t => t.includes(name))) continue;
    const quote = around(text, name);
    if (!quote || !worthKeeping(quote, name, list)) continue;
    taken.add(name);
    found[id] = { text: quote, src, wiki: new URL(src).host, via: 'mention', page: title };
  }
}

// Pages already collected as topics, plus whatever each mod says about itself
// on Modrinth, which for a lot of them is the only writing that exists.
for (const file of fs.readdirSync(IN).filter(f => f.endsWith('.json') && !f.startsWith('_'))) {
  const j = JSON.parse(fs.readFileSync(path.join(IN, file), 'utf8'));
  const ns = j.ns;
  // Skip namespaces already well covered by exact title matches.
  const already = Object.keys(j.docs ?? {}).length;
  for (const [title, d] of Object.entries(j.orphans ?? {})) {
    if (already > 300) break;                      // minecraft.wiki: thousands of unrelated pages
    mine(ns, title, d.text, d.src);
  }
}

for (const [ns, s] of Object.entries(sources)) {
  if (!s.body || s.body.length < 300) continue;
  const url = s.wiki || `https://modrinth.com/mod/${s.slug}`;
  mine(ns, s.title + ' (project page)', s.body.replace(/[#*`>|\-]/g, ' ').replace(/\s+/g, ' '), url);
}

fs.writeFileSync(OUT, JSON.stringify({
  wiki: 'mentions', ns: '*', harvested: new Date().toISOString(),
  matched: Object.keys(found).length, docs: found, orphans: {},
}, null, 1));

const perNs = {};
for (const id of Object.keys(found)) {
  const ns = id.slice(0, id.indexOf(':'));
  perNs[ns] = (perNs[ns] || 0) + 1;
}
console.log(`${pages} prose pages read, ${Object.keys(found).length} items identified by mention`);
for (const [ns, n] of Object.entries(perNs).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(n).padStart(4)} ${ns}`);
}
console.log(`  -> ${OUT}`);
