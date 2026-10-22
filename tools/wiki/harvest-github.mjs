#!/usr/bin/env node
/**
 * Harvests GitHub wikis, which eleven of this pack's mods use.
 *
 *   node harvest-github.mjs                 # every GitHub wiki in sources.json
 *   node harvest-github.mjs --ns supplementaries
 *
 * A GitHub wiki is a git repository of markdown, so it clones in one command.
 * The shape is different from MediaWiki though: instead of a page per item it
 * is a handful of long pages with a heading per item — "## Hourglass" under
 * Functional-Blocks.md. So the join is on headings rather than page titles, but
 * it is the same join: the heading text against the item's display name, which
 * came out of the mod's own lang file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const HERE = import.meta.dirname;
const ICONS = path.join(HERE, '..', '..', 'app', 'public', 'icons');
const OUT = path.join(HERE, 'harvested');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
  return a;
}, []));

const sources = JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8')).sources;
const names = JSON.parse(fs.readFileSync(path.join(ICONS, 'names.json'), 'utf8')).names;

const byNs = {};
for (const [id, name] of Object.entries(names)) {
  const ns = id.slice(0, id.indexOf(':'));
  const key = name.toLowerCase().trim();
  ((byNs[ns] ??= new Map()).has(key)) || byNs[ns].set(key, id);
}

/** Markdown with the noise taken out, so a section reads as prose. */
function clean(md) {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every heading in a file, with the text that follows it. */
function sections(md) {
  const out = [];
  const lines = md.split('\n');
  let title = null, buf = [];
  const flush = () => {
    if (title) out.push([title, clean(buf.join('\n'))]);
    buf = [];
  };
  for (const line of lines) {
    const h = /^#{1,4}\s+(.+?)\s*$/.exec(line);
    if (h) { flush(); title = h[1].replace(/[*_`#]/g, '').trim(); }
    else buf.push(line);
  }
  flush();
  return out;
}

const targets = Object.entries(sources)
  .filter(([ns, s]) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/wiki\/?$/.test(s.wiki || ''))
  .filter(([ns]) => !args.ns || ns === args.ns)
  .sort((a, b) => b[1].items - a[1].items);

console.log(`${targets.length} GitHub wikis to harvest`);
fs.mkdirSync(OUT, { recursive: true });

for (const [ns, s] of targets) {
  const repo = s.wiki.replace(/\/wiki\/?$/, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'));
  try {
    execFileSync('git', ['clone', '-q', '--depth', '1', repo + '.wiki.git', dir],
      { stdio: 'pipe', timeout: 60000 });
  } catch {
    console.log(`  ---  ${ns.padEnd(22)} no wiki repo at ${repo}.wiki.git`);
    continue;
  }

  const want = byNs[ns] ?? new Map();
  const docs = {}, orphans = {};
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const md = fs.readFileSync(path.join(dir, file), 'utf8');
    const page = file.replace(/\.md$/, '');
    for (const [title, body] of sections(md)) {
      if (body.length < 60) continue;
      const text = body.length > 600 ? body.slice(0, 600).replace(/\s+\S*$/, '') + '…' : body;
      const src = `${repo}/wiki/${encodeURIComponent(page)}#${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const id = want.get(title.toLowerCase().trim());
      if (id) docs[id] = { text, src, title };
      else orphans[`${page}: ${title}`] = { text, src };
    }
  }

  fs.writeFileSync(path.join(OUT, `${ns}.gh.json`), JSON.stringify({
    wiki: repo.replace('https://', '') + '/wiki', ns, harvested: new Date().toISOString(),
    matched: Object.keys(docs).length, unmatched: Object.keys(orphans).length,
    docs, orphans,
  }, null, 1));
  console.log(`  ${String(s.items).padStart(5)} ${ns.padEnd(22)} ${Object.keys(docs).length} items,`
    + ` ${Object.keys(orphans).length} topics`);
}
