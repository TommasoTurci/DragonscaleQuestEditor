# Dragonscale Quest Editor

An external editor for the Dragonscale quest book. Two halves:

- **`bridge/`** — a NeoForge mod running inside the dev server. Owns the live quest
  book, serves it over HTTP/WebSocket, applies edits through FTB's own API, and keeps
  a git history of every change.
- **`app/`** — a web editor (desktop and tablet) that talks to the bridge. Never reads
  or writes a quest file.

Design rationale and the file-format research live in [`docs/`](docs/). The short
version: the server is the only authority, so the editor never parses SNBT and never
risks corrupting the book. Git sits underneath as the history layer, driven entirely
by the bridge — nobody using the editor sees a commit.

---

## Why a bridge rather than file editing

Editing files under a running server does not work. FTB Quests holds the book in
memory and rewrites those files on its own schedule, so anything written underneath
is lost at the next save. Going through the server instead gets three things for
free:

- **Live collaboration.** One person edits in game, another on a tablet, both see
  each other immediately — because FTB already broadcasts edits to connected clients
  and the bridge reuses that machinery.
- **Correct serialization, always.** FTB writes the SNBT, so unknown fields from
  addons, conditional defaults and the lang-file split are all FTB's problem, not
  ours.
- **Every quest type, with no per-type code.** The bridge introspects the live
  registries, so a new addon's task types appear in the editor without either half
  being rebuilt.

---

## API contract

Everything is JSON. One shared token in the bridge config, sent as
`Authorization: Bearer <token>`. It is a dev server, but it is on the public
internet.

### `GET /book`

The whole book. Quest data is passed through verbatim as NBT-shaped JSON — the
bridge models nothing, so addon fields survive by construction.

```json
{
  "version": 412,
  "chapterGroups": [],
  "chapters": [
    {
      "id": "3D94C1963CD045BB",
      "filename": "the_beginnings",
      "text": { "title": "The Beginnings" },
      "data": { "order_index": 0, "icon": { "id": "ftbquests:custom_icon" } },
      "quests": [
        {
          "id": "345900C71CE2A226",
          "text": {
            "title": "Obtain Wood",
            "subtitle": "The wood is wooding out...",
            "description": ["The wood is something crazy..."]
          },
          "data": {
            "x": 0.0, "y": 0.5,
            "dependencies": [],
            "tasks": [
              { "id": "578281D6ED6FC5E6", "type": "item",
                "item": { "count": 1, "id": "minecraft:oak_log" } }
            ],
            "rewards": []
          }
        }
      ]
    }
  ]
}
```

`version` increments on every applied change and is what `/ops` checks against.

### `GET /types`

Every registered task and reward type, with its fields discovered at runtime rather
than hard-coded. The bridge constructs a default instance of each type, serializes
it, and reports the resulting keys and value types.

```json
{
  "tasks": {
    "item":        { "fields": { "item": "item_stack", "count": "long",
                                 "consume_items": "tristate",
                                 "only_from_crafting": "tristate" } },
    "checkmark":   { "fields": {} },
    "break_block": { "fields": { "block_tag": "string", "value": "long" } }
  },
  "rewards": {
    "item": { "fields": { "item": "item_stack", "count": "int" } },
    "xp":   { "fields": { "xp": "int" } }
  }
}
```

Fields absent from a default instance are optional and default to whatever FTB uses
when the key is missing. The editor must treat a missing key as a default, never as
null, and must never write a value back that equals the default.

### `GET /items`

Registry ids and tags, read live from the server. No export step, nothing to
regenerate after a pack update.

```json
{ "items": ["minecraft:oak_log", "create:andesite_alloy"],
  "tags":  { "c:ingots/steel": ["createbigcannons:steel_ingot"] } }
```

### `WS /changes`

The bridge pushes every applied change, whatever its source — the web editor, a
player editing in game, or a `/restore`.

```json
{ "version": 413,
  "changes": [ { "op": "set", "target": "quest:345900C71CE2A226",
                 "path": "data.x", "value": 3.5 } ] }
```

Clients apply these without reloading, and without stealing focus from whatever the
user is currently typing.

### `POST /ops`

Apply an edit. Rejected with `409` and the current version if `baseVersion` is stale,
so a client that has fallen behind re-syncs rather than clobbering.

```json
{ "baseVersion": 412,
  "ops": [
    { "op": "set",     "target": "quest:345900C71CE2A226", "path": "data.x", "value": 3.5 },
    { "op": "setText", "target": "quest:345900C71CE2A226", "key": "title", "value": "Obtain Wood" },
    { "op": "create",  "kind": "quest", "parent": "3D94C1963CD045BB", "data": { "x": 0, "y": 0 } },
    { "op": "delete",  "target": "quest:4A9AB09E647E7B4C" }
  ] }
```

Ops in one request are applied as a batch and produce one commit.

### `GET /history` and `POST /restore`

`/history` returns the commit log — who, when, what changed. `/restore` takes a
commit id, checks the files out at that point, has the server re-read the book, and
pushes a full resync to every client. The word "git" never appears in the UI.

---

## History

The bridge owns the files, so the bridge owns the commits.

1. An edit arrives (or someone edits in game).
2. It is applied to the live book and broadcast. No save, no reload, no restart.
3. After a short idle gap the bridge flushes the book with `writeDataFull`, commits
   with the editor's name and the quest title, and pushes.

Debounce matters — a commit per keystroke makes the history useless. A few seconds of
quiet is about one commit per meaningful edit.

**This repository is not the one the server pulls from.** `DragonscaleKubeJS` is
synced to the VM by a cron that runs `git reset --hard` every minute; quest data must
never live there or every unpushed edit is destroyed. Quest data gets its own
repository, written only by the bridge.

---

## Layout

```
bridge/   NeoForge mod: HTTP + WS server, FTB API calls, git history
app/      web editor: canvas, inspector, item picker
tools/    build scripts that run on a desktop, not the server
  icons/  generates the icon set from the pack's mod jars
docs/     format research and design notes
```

## Status

| | |
|---|---|
| Format research | done — see [`docs/format.md`](docs/format.md) |
| API contract | drafted, this file |
| Icon pipeline | in progress |
| Bridge | not started |
| Editor | not started |
