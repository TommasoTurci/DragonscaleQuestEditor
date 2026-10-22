#!/usr/bin/env node
/**
 * Builds the editor's mod table from the pack's jars.
 *
 *   node build-mods.mjs --mods "<mods folder>"
 *
 * Every mod ships a `META-INF/neoforge.mods.toml` carrying a name, a description
 * and usually a link, all written by the person who made it. That is the one
 * description of a mod that is certain to be accurate, it costs nothing to read,
 * and it answers most of "what is this thing and where did it come from" before
 * anyone has to look anything up.
 *
 * 301 of this pack's 313 mods have one worth showing.
 *
 * Output is `mods.json` beside the icons. Derived from the jars, so not committed.
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
const OUT = path.resolve(args.out
  ?? path.join(import.meta.dirname, '..', '..', 'app', 'public', 'icons'));

if (!MODS || !fs.existsSync(MODS)) {
  console.error('usage: node build-mods.mjs --mods "<mods folder>"');
  process.exit(2);
}

/**
 * Just enough TOML. The file is a known shape and a real parser is a dependency
 * for three field reads; what matters is handling ''' blocks, which is where
 * every description lives and where a line-based reader would fall over.
 */
function readToml(text) {
  const blocks = [];
  // Each [[mods]] section is one mod; a jar may declare several.
  for (const chunk of text.split(/\[\[mods\]\]/).slice(1)) {
    const take = key => {
      const multi = new RegExp(key + "\\s*=\\s*'''([\\s\\S]*?)'''").exec(chunk);
      if (multi) return multi[1].trim();
      const single = new RegExp(key + '\\s*=\\s*"([^"]*)"').exec(chunk);
      return single ? single[1].trim() : '';
    };
    const id = take('modId');
    if (!id) continue;
    blocks.push({
      id,
      name: take('displayName') || id,
      description: take('description').replace(/\s*\n\s*/g, ' ').trim(),
      authors: take('authors'),
      url: take('displayURL'),
      version: take('version'),
    });
  }
  return blocks;
}

const mods = {};
let jars = 0;

for (const file of fs.readdirSync(MODS).filter(f => f.endsWith('.jar'))) {
  let zip;
  try { zip = new AdmZip(path.join(MODS, file)); } catch { continue; }
  const entry = zip.getEntry('META-INF/neoforge.mods.toml') || zip.getEntry('META-INF/mods.toml');
  if (!entry) continue;
  jars++;
  let text;
  try { text = zip.readAsText(entry); } catch { continue; }
  for (const mod of readToml(text)) {
    // A version placeholder that was never substituted says nothing.
    if (/\$\{|^\s*$/.test(mod.version)) mod.version = '';
    // "All Rights Reserved" and friends are not descriptions.
    if (mod.description.length < 16) mod.description = '';
    mods[mod.id] = mod;
  }
}

fs.mkdirSync(OUT, { recursive: true });
const out = path.join(OUT, 'mods.json');
fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(),
  count: Object.keys(mods).length, mods }));

const described = Object.values(mods).filter(m => m.description).length;
const linked = Object.values(mods).filter(m => m.url).length;
console.log(`${Object.keys(mods).length} mods from ${jars} jars`);
console.log(`  ${described} with a description, ${linked} with a link`);
console.log(`  -> ${out}`);
