#!/usr/bin/env node
/**
 * Serves the editor against a fake bridge, so the app can be developed without a
 * running Minecraft server.
 *
 *   node mock-server.mjs --book "<path to config/ftbquests/quests>" [--icons <dir>] [--port 25580]
 *
 * The book is parsed out of the real SNBT with a deliberately crude reader — just
 * enough structure to render: ids, coordinates, dependencies and tasks. The real
 * bridge gets this JSON from FTB itself and does not share any of this code.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));

const BOOK = args.book;
const WWW = path.resolve(args.www ?? path.join(import.meta.dirname, '..', '..', 'app', 'www'));
const ICONS = path.resolve(args.icons ?? path.join(import.meta.dirname, '..', '..', 'app', 'public', 'icons'));
const PORT = Number(args.port ?? 25580);
const TOKEN = args.token ?? 'mock';

// ------------------------------------------------------------- crude SNBT ---
/** Yields the text of each `{ ... }` block inside the list that `start` opens. */
function* balancedBlocks(text, start) {
  const m = text.match(start);
  if (!m) return;
  let i = text.indexOf('\n', m.index);
  while (i >= 0 && i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) return;
    // A `]` before the next `{` means the list has ended.
    const close = text.indexOf(']', i);
    if (close >= 0 && close < open) return;
    let depth = 0, j = open;
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}' && --depth === 0) break;
    }
    yield text.slice(open, j + 1);
    i = j + 1;
  }
}

/** Reads the subset the renderer needs. Not a general parser; see docs/format.md. */
function parseChapter(text) {
  const str = k => (text.match(new RegExp(`^\\t${k}: "([^"]*)"`, 'm')) || [])[1] ?? '';
  const chapter = { id: str('id'), filename: str('filename'), quests: [] };

  // Quests start at exactly three tabs of indentation inside the quests: [ ... ] list.
  const body = text.split(/^\tquests: \[$/m)[1] ?? '';
  for (const block of body.split(/^\t\t\{$/m).slice(1)) {
    const chunk = block.split(/^\t\t\}$/m)[0];
    const g = (re) => (chunk.match(re) || [])[1];
    const id = g(/^\t\t\tid: "([0-9A-F]{16})"/m);
    if (!id) continue;
    const deps = (g(/^\t\t\tdependencies: \[(.*?)\]/ms) || '')
      .match(/"[0-9A-F]{16}"/g)?.map(s => s.slice(1, -1)) ?? [];
    // Tasks nest two levels deep in practice -- item: { components: { ... } } -- so
    // a regex over braces does not survive. Scan with a brace counter instead.
    const tasks = [];
    for (const body of balancedBlocks(chunk, /^\t\t\ttasks: \[/m)) {
      const type = (body.match(/^\t+type: "([a-z_]+)"/m) || [])[1];
      if (!type) continue;
      // The task's own icon wins: an item task may point at a filter rather than a
      // real item, and the filter has no icon of its own.
      const icon = (body.match(/icon: \{\s*id: "([^"]+)"/s) || [])[1];
      const itemLine = (body.match(/^\t+item: (\{.*\}|"[^"]+")$/m) || [])[1] ?? '';
      const item = (itemLine.match(/id: "([^"]+)"/) || itemLine.match(/^"([^"]+)"$/) || [])[1];
      const filter = (itemLine.match(/"ftbfiltersystem:filter": "([^"]+)"/) || [])[1];
      tasks.push({
        type,
        ...(item ? { item: { id: item, count: Number((itemLine.match(/count: (\d+)/) || [])[1] ?? 1) } } : {}),
        ...(icon ? { icon: { id: icon } } : {}),
        ...(filter ? { filter } : {})
      });
    }
    chapter.quests.push({
      id,
      text: {},
      data: {
        x: Number(g(/^\t\t\tx: ([-0-9.]+)d/m) ?? 0),
        y: Number(g(/^\t\t\ty: ([-0-9.]+)d/m) ?? 0),
        size: Number(g(/^\t\t\tsize: ([0-9.]+)d/m) ?? 1),
        shape: g(/^\t\t\tshape: "([a-z]+)"/m) ?? 'circle',
        dependencies: deps,
        tasks
      }
    });
  }
  return chapter;
}

function loadBook() {
  const dir = path.join(BOOK, 'chapters');
  const chapters = fs.readdirSync(dir).filter(f => f.endsWith('.snbt'))
    .map(f => parseChapter(fs.readFileSync(path.join(dir, f), 'utf8')));

  // Titles live in the lang file, keyed by object id.
  const langPath = path.join(BOOK, 'lang', 'en_us.snbt');
  const titles = {};
  if (fs.existsSync(langPath)) {
    for (const m of fs.readFileSync(langPath, 'utf8')
      .matchAll(/^\t(chapter|quest)\.([0-9A-F]{16})\.title: "([^"]*)"/gm)) titles[m[2]] = m[3];
  }
  for (const c of chapters) {
    c.text = { title: titles[c.id] ?? c.filename };
    for (const q of c.quests) q.text = { title: titles[q.id] ?? '' };
  }
  return { version: 1, chapterGroups: [{ id: '0'.repeat(16), title: '', chapters }] };
}

// ---------------------------------------------------------------- serving ---
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css',
                json: 'application/json', png: 'image/png' };
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
const authed = req => (req.headers.authorization === 'Bearer ' + TOKEN)
  || new URL(req.url, 'http://x').searchParams.get('token') === TOKEN;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    if (!authed(req)) return send(res, 401, 'application/json', '{"error":"unauthorized"}');
    if (p === '/api/health') return send(res, 200, 'application/json', JSON.stringify({ ok: true, mock: true }));
    if (p === '/api/book') return send(res, 200, 'application/json', JSON.stringify(loadBook()));
    if (p === '/api/types') return send(res, 200, 'application/json', '{"tasks":{},"rewards":{}}');
    if (p === '/api/changes') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: hello\ndata: {"version":1}\n\n');
      return;                                  // held open, nothing pushed
    }
    return send(res, 404, 'application/json', '{"error":"not found"}');
  }

  const base = p.startsWith('/icons/') ? ICONS : WWW;
  const rel = p.startsWith('/icons/') ? p.slice(7) : (p === '/' ? 'index.html' : p.slice(1));
  const file = path.join(base, decodeURIComponent(rel));
  if (!file.startsWith(base)) return send(res, 400, 'text/plain', 'bad path');
  fs.readFile(file, (err, buf) => err
    ? send(res, 404, 'text/plain', 'not found')
    : send(res, 200, TYPES[file.split('.').pop()] ?? 'application/octet-stream', buf));
}).listen(PORT, '127.0.0.1', () => {
  const b = loadBook();
  const n = b.chapterGroups[0].chapters.reduce((s, c) => s + c.quests.length, 0);
  console.log(`mock bridge on http://127.0.0.1:${PORT}  token=${TOKEN}`);
  console.log(`  ${b.chapterGroups[0].chapters.length} chapter(s), ${n} quests`);
});
