#!/usr/bin/env node
/**
 * Harvests a mod's wiki into per-item documentation.
 *
 *   node harvest.mjs --wiki create.fandom.com --ns create
 *   node harvest.mjs --wiki minecraft.wiki --ns minecraft
 *
 * Most of these wikis are MediaWiki, which means the whole thing can be pulled
 * through api.php in a few dozen requests instead of fetching thousands of pages
 * one at a time: `list=allpages` for the titles, then page content 50 at a time.
 *
 * Matching a page to an item is done on the display name — the Create wiki's
 * "Andesite Alloy" is `create:andesite_alloy`, which `names.json` already knows
 * because it was read out of the mod's own lang file. That is a far safer join
 * than guessing at ids, and it means a page that does not correspond to an item
 * (a mechanic, a tutorial) simply does not match and is kept separately.
 *
 * Output is one JSON per wiki in `tools/wiki/harvested/`; `merge.mjs` combines
 * them into the `docs.json` the editor loads.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const WIKI = args.wiki;
const NS = args.ns;
const ICONS = path.resolve(args.icons
  ?? path.join(import.meta.dirname, '..', '..', 'app', 'public', 'icons'));
const OUT = path.resolve(args.out ?? path.join(import.meta.dirname, 'harvested'));
const LIMIT = Number(args.limit ?? 0);          // 0 = the whole wiki
const UA = 'DragonscaleQuestEditor/0.1 (private modpack documentation tooling)';

if (!WIKI || !NS) {
  console.error('usage: node harvest.mjs --wiki <host> --ns <mod namespace>');
  process.exit(2);
}

const api = (params) =>
  `https://${WIKI}/api.php?${new URLSearchParams({ format: 'json', ...params })}`;

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) return await r.json();
      // 429 and friends: back off rather than hammering someone's wiki.
      await sleep(1200 * (i + 1));
    } catch {
      await sleep(1200 * (i + 1));
    }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------- page titles --

async function allTitles() {
  const titles = [];
  let cont = null;
  do {
    const j = await get(api({ action: 'query', list: 'allpages', aplimit: '500',
      apfilterredir: 'nonredirects', ...(cont ? { apcontinue: cont } : {}) }));
    if (!j) break;
    for (const p of j.query?.allpages ?? []) titles.push(p.title);
    cont = j.continue?.apcontinue ?? null;
    process.stdout.write(`\r  ${titles.length} titles`);
    if (LIMIT && titles.length >= LIMIT) break;
    await sleep(250);
  } while (cont);
  process.stdout.write('\n');
  return LIMIT ? titles.slice(0, LIMIT) : titles;
}

// ---------------------------------------------------------------- content --

/**
 * Wikitext to one readable paragraph.
 *
 * Deliberately blunt: strip templates, links, tags and formatting, then take the
 * first paragraph with enough prose in it to be a description. Infoboxes and
 * navboxes are templates, so they vanish; so do the one-line stubs that would
 * otherwise produce a confident sentence saying nothing.
 */
function firstParagraph(text) {
  if (!text) return '';
  let t = text;
  // Templates, nested a few deep.
  for (let i = 0; i < 6; i++) t = t.replace(/\{\{[^{}]*\}\}/g, '');
  t = t
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/'''?/g, '')
    .replace(/^\s*[*#:;|].*$/gm, '')          // lists and table rows
    .replace(/^\s*=.*$/gm, '');                // headings

  for (const para of t.split(/\n\s*\n/)) {
    const p = para.replace(/\s+/g, ' ').trim();
    if (p.length < 60) continue;
    if (!/[a-z]\s+[a-z]/i.test(p)) continue;   // not prose
    return p.length > 600 ? p.slice(0, 600).replace(/\s+\S*$/, '') + '…' : p;
  }
  return '';
}

async function contentFor(titles) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const j = await get(api({ action: 'query', titles: batch.join('|'),
      prop: 'revisions', rvprop: 'content', rvslots: 'main' }));
    for (const page of Object.values(j?.query?.pages ?? {})) {
      const raw = page.revisions?.[0]?.slots?.main?.['*'] ?? page.revisions?.[0]?.['*'];
      const para = firstParagraph(raw);
      if (para) out.set(page.title, para);
    }
    process.stdout.write(`\r  ${Math.min(i + 50, titles.length)}/${titles.length} pages, ${out.size} with prose`);
    await sleep(250);
  }
  process.stdout.write('\n');
  return out;
}

// ------------------------------------------------------------------- match --

/** "Andesite Alloy" -> create:andesite_alloy, via the names read from the jars. */
function buildIndex() {
  const names = JSON.parse(fs.readFileSync(path.join(ICONS, 'names.json'), 'utf8')).names;
  const byName = new Map();
  for (const [id, name] of Object.entries(names)) {
    if (NS !== '*' && id.slice(0, id.indexOf(':')) !== NS) continue;
    const key = name.toLowerCase().trim();
    // First id wins; a later duplicate is usually a variant block of the same name.
    if (!byName.has(key)) byName.set(key, id);
  }
  return byName;
}

// -------------------------------------------------------------------- main --

const byName = buildIndex();
console.log(`${WIKI} -> ${NS}  (${byName.size} named items in this namespace)`);

const titles = await allTitles();
if (!titles.length) {
  console.error('no pages; is the API reachable?');
  process.exit(1);
}
const content = await contentFor(titles);

const docs = {};
const orphans = {};
for (const [title, text] of content) {
  const id = byName.get(title.toLowerCase().trim());
  const src = `https://${WIKI}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  if (id) docs[id] = { text, src, title };
  else orphans[title] = { text, src };
}

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `${NS}.json`);
fs.writeFileSync(file, JSON.stringify({
  wiki: WIKI, ns: NS, harvested: new Date().toISOString(),
  matched: Object.keys(docs).length, unmatched: Object.keys(orphans).length,
  docs, orphans,
}, null, 1));

console.log(`  matched ${Object.keys(docs).length} items`
  + ` (${(100 * Object.keys(docs).length / Math.max(1, byName.size)).toFixed(0)}% of the namespace)`);
console.log(`  ${Object.keys(orphans).length} pages kept as non-item topics`);
console.log(`  -> ${file}`);
