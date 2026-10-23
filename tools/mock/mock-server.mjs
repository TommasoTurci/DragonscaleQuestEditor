#!/usr/bin/env node
/**
 * Serves the editor against a fake bridge, so the app can be developed and the edit
 * loop exercised without a running Minecraft server.
 *
 *   node mock-server.mjs --book "<path to config/ftbquests/quests>" [--icons <dir>] [--port 25580]
 *
 * It speaks the same API as the real bridge and produces the same JSON shape, so
 * what works here works there. Two deliberate differences:
 *
 *   - Edits are applied in memory and never written back. Restarting the mock
 *     restores the book as it is on disk. Writing SNBT correctly is the real
 *     bridge's job, and it does it by asking FTB to save.
 *   - /api/types is derived from the task and reward types this book happens to
 *     use, with field defaults taken from the data actually present. The real
 *     bridge asks the registries, so it reports every installed type including the
 *     unused ones. Nothing here is invented either way.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parse } from './snbt.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));

const BOOK = args.book;
const WWW = path.resolve(args.www ?? path.join(import.meta.dirname, '..', '..', 'app', 'www'));
const ICONS = path.resolve(args.icons ?? path.join(import.meta.dirname, '..', '..', 'app', 'public', 'icons'));
const PORT = Number(args.port ?? 25580);
const TOKEN = args.token ?? 'mock';

// ------------------------------------------------------------------- naming --
// Used by both the loader and the edit path, so declared before either.

const lines = v => Array.isArray(v) ? v.map(String) : String(v ?? '').split('\n');
const normalise = t => String(t).includes(':') ? String(t).split(':').pop() : String(t);
const short = t => (t ?? 'item').split(':').pop();
const full = t => !t ? 'ftbquests:item' : (t.includes(':') ? t : 'ftbquests:' + t);

// ------------------------------------------------------------------ loading --

/** Titles, subtitles and descriptions live in the lang file, keyed by object id. */
function loadText() {
  const file = path.join(BOOK, 'lang', 'en_us.snbt');
  if (!fs.existsSync(file)) return {};
  const flat = parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const [key, value] of Object.entries(flat)) {
    const m = /^(?:chapter|quest|task|reward)\.([0-9A-F]{16})\.(title|quest_subtitle|quest_desc|chapter_subtitle)$/.exec(key);
    if (!m) continue;
    const field = { title: 'title', quest_subtitle: 'subtitle',
                    quest_desc: 'description', chapter_subtitle: 'subtitle' }[m[2]];
    (out[m[1]] ??= {})[field] = value;
  }
  return out;
}

const strip = (o, ...keys) => {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
};

/** A task or a reward, in the shape BookReader reports. */
function child(raw, text) {
  const t = text[raw.id] ?? {};
  return {
    id: raw.id,
    typeId: full(raw.type),
    text: { rawTitle: t.title ?? '', ...(t.title ? { title: t.title } : {}) },
    data: raw
  };
}

function loadBook() {
  const text = loadText();
  const dir = path.join(BOOK, 'chapters');
  const chapters = fs.readdirSync(dir).filter(f => f.endsWith('.snbt')).map(f => {
    const raw = parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const ct = text[raw.id] ?? {};
    return {
      id: raw.id,
      text: { rawTitle: ct.title ?? '', title: ct.title ?? raw.filename,
              subtitle: ct.subtitle ?? [] },
      data: strip(raw, 'quests'),
      quests: (raw.quests ?? []).map(q => {
        const qt = text[q.id] ?? {};
        return {
          id: q.id,
          chapter: raw.id,
          text: { rawTitle: qt.title ?? '', ...(qt.title ? { title: qt.title } : {}),
                  subtitle: qt.subtitle ?? '', description: qt.description ?? [] },
          data: strip(q, 'tasks', 'rewards'),
          tasks: (q.tasks ?? []).map(t => child(t, text)),
          rewards: (q.rewards ?? []).map(r => child(r, text))
        };
      })
    };
  });

  // Chapter order is the book's own, not the directory listing's.
  chapters.sort((a, b) => (a.data.order_index ?? 0) - (b.data.order_index ?? 0));
  return { version: 1, chapterGroups: [{ id: '0'.repeat(16), title: '', chapters }] };
}

let book = loadBook();

// ------------------------------------------------------------------- lookup --

/** id -> { kind, obj, parent, list }, rebuilt per edit rather than kept in sync. */
function index() {
  const map = new Map();
  for (const g of book.chapterGroups) {
    for (const c of g.chapters) {
      map.set(c.id, { kind: 'chapter', obj: c, list: g.chapters });
      for (const q of c.quests) {
        map.set(q.id, { kind: 'quest', obj: q, parent: c, list: c.quests });
        for (const t of q.tasks) map.set(t.id, { kind: 'task', obj: t, parent: q, list: q.tasks });
        for (const r of q.rewards) map.set(r.id, { kind: 'reward', obj: r, parent: q, list: q.rewards });
      }
    }
  }
  return map;
}

/**
 * The type catalogue, from what the book uses. A field's default is the first value
 * seen for that key, standing in for the registry default the real bridge reports —
 * close enough to build a form against.
 */
function types() {
  const out = { tasks: {}, rewards: {} };
  for (const { kind, obj } of index().values()) {
    if (kind !== 'task' && kind !== 'reward') continue;
    const bucket = kind === 'task' ? out.tasks : out.rewards;
    const entry = bucket[obj.typeId] ??= {
      id: obj.typeId, nbtType: short(obj.data.type), label: '',
      namespace: obj.typeId.split(':')[0], fields: {}
    };
    const declared = obj.data.$types ?? {};
    for (const [key, value] of Object.entries(obj.data)) {
      if (key === 'id' || key === 'type' || key === '$types') continue;
      entry.fields[key] ??= { type: declared[key] ?? inferred(value), default: value };
    }
  }
  return out;
}

const inferred = v => Array.isArray(v) ? 'list'
  : v === null ? 'string'
  : typeof v === 'object' ? 'compound'
  : typeof v === 'boolean' ? 'boolean'
  : typeof v === 'number' ? 'number' : 'string';

// -------------------------------------------------------------------- edits --

const subscribers = new Set();
const mockNotes = {};

function publish(change) {
  const line = `data: ${JSON.stringify(change)}\n\n`;
  for (const res of subscribers) { try { res.write(line); } catch {} }
}

const newId = () => Array.from({ length: 16 },
  () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');

class BadEdit extends Error {}

/**
 * A stand-in for the bridge's git history: a deep copy of the book before each
 * batch, kept in memory. The real thing commits to a repository in the quest
 * folder, which is the only place a history can live that the server will not
 * overwrite. This exists so the history and restore screens can be built.
 */
/** The icon index doubles as a real item list, so the picker has real data. */
let iconIndex = null;
function icons() {
  if (iconIndex) return iconIndex;
  try {
    iconIndex = JSON.parse(fs.readFileSync(path.join(ICONS, 'index.json'), 'utf8')).icons || {};
  } catch { iconIndex = {}; }
  return iconIndex;
}

const hex = n => Array.from({ length: n },
  () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

const commits = [{ id: hex(40), author: 'Quest Bridge', when: new Date().toISOString(),
                   message: 'Quest book as it stood when the bridge first ran',
                   book: structuredClone(book) }];

/** Newest first, holding the book as it stood after the change — as git does. */
function record(message) {
  commits.unshift({
    id: hex(40), author: 'Quest Bridge', when: new Date().toISOString(),
    message, book: structuredClone(book)
  });
}

function at(obj, dotted, value) {
  const path = dotted.split('.');
  let cur = obj;
  for (const key of path.slice(0, -1)) cur = (cur[key] ??= {});
  const leaf = path[path.length - 1];
  if (value === null) delete cur[leaf];
  else cur[leaf] = value;
}

function applyEdits(edits) {
  const touched = new Set(), created = [];
  let applied = 0;

  for (const edit of edits) {
    const map = index();
    const found = edit.target ? map.get(normalise(edit.target)) : null;
    if (edit.target && !found) throw new BadEdit(`no such object: ${edit.target}`);

    switch (edit.op) {
      case 'set': {
        const fields = edit.fields ?? { [edit.path]: edit.value };
        for (const [p, v] of Object.entries(fields)) {
          if (!p.startsWith('data.')) throw new BadEdit(`set path must start with 'data.' (got ${p})`);
          at(found.obj, p, v);
        }
        touched.add(found.obj.id);
        break;
      }
      case 'setText': {
        if (!['title', 'subtitle', 'description'].includes(edit.key)) {
          throw new BadEdit(`unknown text key: ${edit.key}`);
        }
        const listVal = edit.key === 'description'
          || (found.kind === 'chapter' && edit.key === 'subtitle');
        if (edit.key === 'title') {
          found.obj.text.rawTitle = String(edit.value ?? '');
          found.obj.text.title = String(edit.value ?? '');
        } else {
          found.obj.text[edit.key] = listVal ? lines(edit.value) : String(edit.value ?? '');
        }
        touched.add(found.obj.id);
        break;
      }
      case 'create': {
        const parent = map.get(normalise(edit.parent));
        if (!parent) throw new BadEdit(`no such parent: ${edit.parent}`);
        const id = newId();
        const made = edit.kind === 'quest'
          ? { id, chapter: parent.obj.id, text: { rawTitle: '', subtitle: '', description: [] },
              data: { id, ...(edit.data ?? {}) }, tasks: [], rewards: [] }
          : { id, typeId: full(edit.type), text: { rawTitle: '' },
              data: { id, type: short(edit.type), ...(edit.data ?? {}) } };
        if (edit.kind === 'quest') parent.obj.quests.push(made);
        else if (edit.kind === 'task') parent.obj.tasks.push(made);
        else if (edit.kind === 'reward') parent.obj.rewards.push(made);
        else throw new BadEdit(`cannot create a ${edit.kind}`);
        for (const [key, value] of Object.entries(edit.text ?? {})) {
          if (key === 'title') { made.text.rawTitle = value; made.text.title = value; }
          else made.text[key] = value;
        }
        created.push(id);
        touched.add(id);
        break;
      }
      case 'delete': {
        // Deleting a quest takes its tasks with it, which the index handles by
        // being rebuilt; nothing else refers to them.
        found.list.splice(found.list.indexOf(found.obj), 1);
        touched.add(found.obj.id);
        break;
      }
      default: throw new BadEdit(`unsupported op: ${edit.op}`);
    }
    applied++;
  }

  book.version++;
  record(applied + ' edit' + (applied === 1 ? '' : 's') + ' to ' + [...touched].join(', '));
  return { version: book.version, applied, touched: [...touched], created };
}

// ------------------------------------------------------------------ serving --
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css',
                json: 'application/json', png: 'image/png', svg: 'image/svg+xml' };
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
const json = (res, code, body) => send(res, code, 'application/json', JSON.stringify(body));
const authed = req => (req.headers.authorization === 'Bearer ' + TOKEN)
  || new URL(req.url, 'http://x').searchParams.get('token') === TOKEN;

const readBody = req => new Promise((resolve, reject) => {
  let buf = '';
  req.on('data', c => { buf += c; if (buf.length > 1e7) reject(new Error('too big')); });
  req.on('end', () => resolve(buf));
  req.on('error', reject);
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

    if (p === '/api/health') {
      return json(res, 200, { ok: true, mock: true, bookVersion: book.version,
                              editors: subscribers.size, bookLoaded: true });
    }
    if (p === '/api/book') return json(res, 200, book);
    if (p === '/api/types') return json(res, 200, types());

    if (p === '/api/changes') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
                           'Connection': 'keep-alive' });
      res.write(`data: ${JSON.stringify({ version: book.version })}\n\n`);
      subscribers.add(res);
      req.on('close', () => subscribers.delete(res));
      return;
    }

    // The real bridge enumerates the running server's registries. There is no
    // server here, so only the two things this mock genuinely knows are offered;
    // everything else comes back empty, which is also what the editor must cope
    // with when a field maps to a registry a pack does not have.
    if (p === '/api/registry') {
      const name = url.searchParams.get('name');
      if (!name) {
        return json(res, 200, { registries: [
          { name: 'minecraft:item', size: Object.keys(icons()).length, tags: 0 },
          { name: 'questbridge:dimensions', size: 3, tags: 0 }
        ] });
      }
      const values = name === 'minecraft:item' ? Object.keys(icons()).sort()
        : name === 'questbridge:dimensions'
          ? ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end']
          : [];
      return json(res, 200, { name, tags: url.searchParams.get('tags') === '1',
                              values, count: values.length });
    }

    // Fabricated, and the type says so. There is no recipe manager here; this
    // exists so the recipe rendering can be built and seen.
    if (p === '/api/recipes') {
      const item = url.searchParams.get('item');
      const ids = Object.keys(icons());
      const pick = n => Array.from({ length: n }, (_, i) =>
        ids[(item.length * 7919 + i * 104729) % ids.length]);
      const p = pick(4);
      return json(res, 200, {
        item,
        makes: [
          // a 3x3 with a hole in the middle, so the layout can be seen
          { id: 'mock:shaped', type: 'minecraft:crafting_shaped', grid: { w: 3, h: 3 },
            inputs: [[p[0]], [p[1]], [p[0]], [p[1]], [], [p[1]], [p[0]], [p[1]], [p[0]]],
            output: { id: item, count: 1 } },
          { id: 'mock:smelt', type: 'minecraft:smelting', inputs: [pick(1)],
            output: { id: item, count: 1 }, time: 200, xp: 0.7 },
          { id: 'mock:modded', type: 'create:milling', inputs: [pick(2)],
            output: { id: item, count: 2 },
            raw: { type: 'create:milling', processing_time: 50,
                   ingredients: [{ item: pick(1)[0] }],
                   results: [{ id: item, count: 2, chance: 1 },
                             { id: pick(2)[1], chance: 0.35 }] } },
          { id: 'mock:mix', type: 'create:mixing', inputs: [pick(2)],
            output: { id: item, count: 1 },
            raw: { type: 'create:mixing', heat_requirement: 'superheated',
                   ingredients: [{ item: pick(1)[0] }, { fluid: 'minecraft:lava', amount: 250 }],
                   results: [{ id: item, count: 1 }] } },
          { id: 'mock:seq', type: 'create:sequenced_assembly',
            inputs: [pick(1)], output: { id: item, count: 1 },
            raw: { type: 'create:sequenced_assembly', loops: 4,
                   ingredient: { item: pick(1)[0] },
                   transitional_item: { id: pick(2)[1] },
                   results: [{ id: item, chance: 0.9 }],
                   sequence: [
                     { type: 'create:deploying', ingredients: [{ item: pick(3)[2] }] },
                     { type: 'create:pressing', ingredients: [] },
                     { type: 'create:filling', ingredients: [{ fluid: 'minecraft:water', amount: 100 }] }
                   ] } }
        ],
        uses: [{ id: 'mock:used', type: 'minecraft:crafting_shapeless',
                 inputs: [[item], pick(1)], output: { id: pick(1)[0], count: 1 } }],
        total: 0
      });
    }

    if (p === '/api/item') {
      const id = url.searchParams.get('id') || '';
      return json(res, 200, { id, mod: id.split(':')[0],
        tags: ['c:example_tag', 'minecraft:another_tag'], note: mockNotes[id] || '',
        facts: { class: 'ExampleItem', stackSize: 64, durability: 250, enchantable: true,
                 does: ['right-click in the air', 'right-click on a block'],
                 creativeTabs: ['minecraft:tools_and_utilities'] } });
    }
    if (p === '/api/notes') return json(res, 200, { notes: mockNotes, count: Object.keys(mockNotes).length });
    if (p === '/api/note') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const b = JSON.parse(await readBody(req));
      if (b.text) mockNotes[b.id] = b.text; else delete mockNotes[b.id];
      return json(res, 200, { id: b.id, note: mockNotes[b.id] || '' });
    }

    if (p === '/api/history') {
      return json(res, 200, {
        enabled: true,
        commits: commits.map(({ book, ...c }) => c),
        snapshots: []
      });
    }

    if (p === '/api/restore') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'body is not JSON' }); }
      const found = commits.find(c => c.id === body.commit);
      if (!found) return json(res, 400, { error: 'no such commit: ' + body.commit });

      const version = book.version + 1;
      book = structuredClone(found.book);
      book.version = version;
      record('Restored to ' + String(body.commit).slice(0, 8));
      const change = { version, source: 'restore', commit: body.commit };
      publish(change);
      return json(res, 200, change);
    }

    if (p === '/api/edit') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'body is not JSON' }); }

      if (body.baseVersion >= 0 && body.baseVersion !== book.version) {
        return json(res, 409, { error: 'stale', version: book.version });
      }
      if (!Array.isArray(body.edits)) return json(res, 400, { error: 'expected an edits array' });
      try {
        const change = applyEdits(body.edits);
        publish(change);
        return json(res, 200, change);
      } catch (e) {
        if (e instanceof BadEdit) return json(res, 400, { error: e.message });
        console.error(e);
        return json(res, 500, { error: 'edit failed' });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  const base = p.startsWith('/icons/') ? ICONS : WWW;
  const rel = p.startsWith('/icons/') ? p.slice(7) : (p === '/' ? 'index.html' : p.slice(1));
  const file = path.join(base, decodeURIComponent(rel));
  if (!file.startsWith(base)) return send(res, 400, 'text/plain', 'bad path');
  fs.readFile(file, (err, buf) => err
    ? send(res, 404, 'text/plain', 'not found')
    : send(res, 200, TYPES[file.split('.').pop()] ?? 'application/octet-stream', buf));
}).listen(PORT, '127.0.0.1', () => {
  const chapters = book.chapterGroups.flatMap(g => g.chapters);
  const quests = chapters.reduce((s, c) => s + c.quests.length, 0);
  const tasks = chapters.reduce((s, c) => s + c.quests.reduce((n, q) => n + q.tasks.length, 0), 0);
  console.log(`mock bridge on http://127.0.0.1:${PORT}  token=${TOKEN}`);
  console.log(`  ${chapters.length} chapter(s), ${quests} quests, ${tasks} tasks`);
  console.log(`  task types in use: ${Object.keys(types().tasks).join(', ') || 'none'}`);
  console.log('  edits are in memory only; restart to get the book back');
});
