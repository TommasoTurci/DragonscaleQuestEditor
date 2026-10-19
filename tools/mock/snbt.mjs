/**
 * A reader for the SNBT dialect FTB Library writes.
 *
 * Only the mock bridge uses this. The real bridge gets its JSON from FTB itself and
 * never parses a file — but the mock has to read the same book the server would, or
 * the editor is being developed against a shape the server will not produce.
 *
 * The earlier version of the mock scraped the files with regexes and kept being
 * wrong in new ways: a task with its brace on the same line, a component map nested
 * two deep, a quoted key with a colon in it. A 90-line recursive parser is both
 * shorter and correct.
 *
 * Numbers carry a type suffix in SNBT (`0.5d`, `3L`, `1b`). The suffix is the only
 * record of the NBT type, so it is kept in a parallel `$types` map the same way the
 * bridge's NbtJson does, rather than being thrown away.
 */

const SUFFIX = { b: 'byte', s: 'short', l: 'long', f: 'float', d: 'double' };

export function parse(text) {
  const p = { s: text, i: 0 };
  ws(p);
  const v = value(p);
  return v;
}

function ws(p) {
  for (;;) {
    while (p.i < p.s.length && /[\s,]/.test(p.s[p.i])) p.i++;
    // FTB does not write comments, but hand-edited books acquire them.
    if (p.s.startsWith('//', p.i)) {
      while (p.i < p.s.length && p.s[p.i] !== '\n') p.i++;
      continue;
    }
    return;
  }
}

function value(p) {
  const c = p.s[p.i];
  if (c === '{') return compound(p);
  if (c === '[') return list(p);
  if (c === '"' || c === "'") return str(p);
  return scalar(p);
}

function compound(p) {
  p.i++;                                   // {
  const out = {};
  const types = {};
  for (;;) {
    ws(p);
    if (p.s[p.i] === '}') { p.i++; break; }
    if (p.i >= p.s.length) break;
    const key = p.s[p.i] === '"' || p.s[p.i] === "'" ? str(p) : bare(p);
    ws(p);
    if (p.s[p.i] === ':') p.i++;
    ws(p);
    const v = value(p);
    out[key] = v?.value !== undefined && v?.$nbt ? v.value : v;
    if (v?.$nbt) types[key] = v.$nbt;
  }
  if (Object.keys(types).length) out.$types = types;
  return out;
}

function list(p) {
  p.i++;                                   // [
  const out = [];
  for (;;) {
    ws(p);
    if (p.s[p.i] === ']') { p.i++; break; }
    if (p.i >= p.s.length) break;
    const v = value(p);
    out.push(v?.$nbt ? v.value : v);
  }
  return out;
}

function str(p) {
  const quote = p.s[p.i++];
  let out = '';
  while (p.i < p.s.length) {
    const c = p.s[p.i++];
    if (c === '\\') { out += unescape(p.s[p.i++]); continue; }
    if (c === quote) break;
    out += c;
  }
  return out;
}

const unescape = c => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c;

function bare(p) {
  const start = p.i;
  while (p.i < p.s.length && /[^:\s{}[\],]/.test(p.s[p.i])) p.i++;
  return p.s.slice(start, p.i);
}

/** A number with an optional NBT type suffix, or a bare true/false/word. */
function scalar(p) {
  const raw = bare(p);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([bslfdBSLFD]?)$/.exec(raw);
  if (!m) return raw;
  const n = Number(m[1]);
  const suffix = SUFFIX[m[2].toLowerCase()];
  if (suffix) return { value: n, $nbt: suffix };
  return { value: n, $nbt: Number.isInteger(n) ? 'int' : 'double' };
}
