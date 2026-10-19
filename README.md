# Dragonscale Quest Editor

An external editor for the Dragonscale quest book. Two halves:

- **`bridge/`** — a NeoForge mod running inside the dev server. Owns the live quest
  book, serves it over HTTP, applies edits through FTB's own API, and keeps
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
`Authorization: Bearer <token>` (or `?token=` on the event stream, which cannot
carry headers). It is a dev server, but it is on the public internet.

### `GET /api/book`

The whole book. Object data is passed through verbatim as NBT-shaped JSON — the
bridge models nothing, so addon fields survive by construction.

Three shapes are worth knowing before reading the sample:

- **Tasks and rewards are siblings of `data`, not fields in it.** `Quest.writeData`
  does not write them; `writeTasks` and `writeRewards` are separate methods. Each
  task is a quest object in its own right with its own id, which is also what makes
  it editable by id with no extra machinery.
- **`text` carries both forms of a title.** `title` is what FTB displays; `rawTitle`
  is what is stored. They differ for an untitled quest, where FTB falls back to the
  name of the first task's item. An edit writes `rawTitle`.
- **`$types` records the NBT type of each numeric leaf**, because JSON has one
  number type and NBT has six. An edit may quote the type back; see `/api/edit`.

```json
{
  "version": 412,
  "chapterGroups": [
    {
      "id": "0000000000000000",
      "title": "",
      "chapters": [
        {
          "id": "3D94C1963CD045BB",
          "text": { "title": "The Beginnings", "rawTitle": "The Beginnings", "subtitle": [] },
          "data": { "order_index": 0, "filename": "the_beginnings" },
          "quests": [
            {
              "id": "4E2B7CEFE64694E7",
              "chapter": "3D94C1963CD045BB",
              "text": {
                "title": "Timberrr!", "rawTitle": "Timberrr!",
                "subtitle": "", "description": []
              },
              "data": {
                "x": 8.5, "y": 1.0,
                "dependencies": ["6BF5FD03DA10CEAD"],
                "icon": { "id": "minecraft:oak_sapling" },
                "$types": { "x": "double", "y": "double" }
              },
              "tasks": [
                {
                  "id": "78FC2707E33D2BAF",
                  "typeId": "ftbquests:item",
                  "text": { "rawTitle": "" },
                  "data": {
                    "type": "item",
                    "item": { "id": "minecraft:oak_log", "count": 1 },
                    "icon": { "id": "minecraft:oak_log" }
                  }
                }
              ],
              "rewards": []
            }
          ]
        }
      ]
    }
  ]
}
```

`version` increments on every applied change, whatever its source, and is what
`/api/edit` checks against.

### `GET /api/types`

Every registered task and reward type, with its fields discovered at runtime rather
than hard-coded. The bridge constructs a default instance of each type, serializes
it, and reports the resulting keys and value types.

```json
{
  "tasks": {
    "ftbquests:item": {
      "id": "ftbquests:item", "nbtType": "item", "namespace": "ftbquests",
      "label": "Item",
      "fields": {
        "count":              { "type": "long",    "default": 1 },
        "only_from_crafting": { "type": "byte",    "default": false },
        "item":               { "type": "compound", "default": { "id": "minecraft:air" } }
      }
    },
    "ftbquests:checkmark": { "id": "ftbquests:checkmark", "nbtType": "checkmark", "fields": {} }
  },
  "rewards": { }
}
```

`typeId` on a task is the registry id; `data.type` is the short name FTB writes to
NBT. Both are reported so a client can map between them.

A field absent from a default instance is one FTB omits at its default value, which
is most of them. The editor treats a missing key as a default rather than as null,
and offers the full field list from here so a default can be written deliberately.

### `GET /api/changes`

Server-sent events, not a WebSocket. Traffic only flows one way — edits arrive by
POST and changes go out — so a socket buys nothing and costs a hand-rolled
handshake and frame codec inside a game server. SSE is plain HTTP, reconnects on
its own in every browser, and survives proxies that mangle upgrades. Consume it
with `new EventSource('/api/changes?token=…')`.

Every applied change is pushed, whatever its source: the web editor, or a player
editing in game.

```json
{ "version": 413, "applied": 2, "touched": ["4E2B7CEFE64694E7"], "created": [] }
{ "version": 414, "source": "game" }
```

A client that sees a version other than its own refetches `/api/book`. The payload
is deliberately not a diff: the book is small, a refetch is simple and always
correct, and there is then one code path to get right rather than two. Clients
apply the result without moving the camera or stealing focus from whatever the user
is typing.

**In-game edits have no event to hook.** FTB fires nothing when a quest object is
edited, and its `markDirty` only sets a private flag, so the bridge fingerprints the
book every two seconds and compares. That only runs while somebody has the editor
open; with nobody connected it costs one branch per tick.

### `POST /api/edit`

Apply a batch. Rejected with `409` and the current version if `baseVersion` is
stale, so a client that has fallen behind re-syncs rather than clobbering. A bad
edit is rejected with `400` and a message meant to be shown.

```json
{ "baseVersion": 412,
  "edits": [
    { "op": "set",     "target": "4E2B7CEFE64694E7", "path": "data.x", "value": 3.5, "type": "double" },
    { "op": "set",     "target": "4E2B7CEFE64694E7", "fields": { "data.size": 2.0, "data.shape": "hexagon" } },
    { "op": "setText", "target": "4E2B7CEFE64694E7", "key": "title", "value": "Timberrr!" },
    { "op": "create",  "kind": "quest", "parent": "3D94C1963CD045BB",
                       "data": { "x": 0, "y": 0 }, "text": { "title": "New" } },
    { "op": "create",  "kind": "task", "parent": "4E2B7CEFE64694E7", "type": "ftbquests:item" },
    { "op": "delete",  "target": "4A9AB09E647E7B4C" }
  ] }
```

| | |
|---|---|
| `target` | an object id, bare or prefixed (`quest:4E2B…`) — quest, task, reward or chapter |
| `path` | always under `data.`, dotted for nesting (`data.item.id`) |
| `type` | optional NBT type: `byte`, `short`, `int`, `long`, `float`, `double`, `string`, `boolean` |
| `key` | `setText` only: `title`, `subtitle` or `description` |
| `kind` | `create` only: `quest`, `task` or `reward` |

The response is the same object the change feed publishes, with `created` carrying
the ids of anything new so the client can select it.

**The `type` hint matters.** A field FTB omitted at its default has no existing tag
to copy the type from, and a bare `2` would be written as an int where FTB wants a
double. With no hint the bridge keeps the type already on disk, and guesses only
when there is nothing to keep.

Field edits for the same object are coalesced into one history event: dragging a
quest sends `x` and `y` as two ops but costs one undo step and one broadcast.

**Edits go through FTB's own history events** — `ModifyQuestObjects`,
`CreateQuestObjects`, `DeleteQuestObjects`, `UpdateTranslation` — rather than being
applied by hand. That is what makes an edit from the web app indistinguishable from
one made in the quest book: the same broadcast to the players actually in edit
mode, the same `editedFromGUIOnServer` hook each type expects, text written through
the translation manager *and* synced to clients, and a place on the same undo stack.

### Items

There is no `/api/items`. `/icons/index.json` already lists every item id in the
pack with a picture for each, which is what an item picker needs; a second list with
no pictures would be strictly worse. Tags are not enumerated — item tasks match tags
through FTB Filter System expressions, which the editor edits as text.

### `GET /api/history` and `POST /api/restore`

`/api/history` returns the commit log of the quest folder, newest first, plus the
full directory copies the bridge takes before the first edit of each session.

```json
{ "enabled": true,
  "commits": [ { "id": "4f2a…", "author": "Quest Bridge",
                 "when": "2026-10-20T01:14:09+02:00", "message": "2 edits to 4E2B…" } ],
  "snapshots": ["ftbquests.before-20261020-011409"] }
```

`/api/restore` takes `{ "commit": "<id>" }` and puts the book back, live: no
restart, and every client is resynced. Three things make that safe enough to put
behind a button.

- **HEAD does not move.** `git read-tree -u --reset` makes the working tree exactly
  that tree — deleting files added since, where `checkout -- .` would leave them —
  and the restore then lands as a new commit *on top of* the history. Undoing a
  restore is just another restore.
- **The state being replaced is committed first**, and a full directory copy is
  taken as well, because this is the one operation here that can destroy a book and
  it should not depend on the machinery it is undoing.
- **The game re-reads with `readDataFull`, not `load()`** — the quest structure
  comes back, team progress is left alone. If that re-read fails the response says
  so rather than claiming success: the files are restored, the memory is not, and a
  restart fixes it.

Git work runs on the HTTP thread (a subprocess has no business on the server
thread); the re-read and the resync run on the server thread (they walk FTB's live
object graph).


## History

The bridge owns the files, so the bridge owns the commits.

1. An edit arrives (or someone edits in game).
2. It is applied to the live book and broadcast. No save, no reload, no restart.
3. After a short idle gap the bridge flushes the book with `saveNow`, commits
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
bridge/   NeoForge mod: HTTP server, FTB API calls, git history
app/      web editor: canvas, inspector, item picker
tools/    build scripts that run on a desktop, not the server
  icons/  generates the icon set from the pack mod jars (gitignored output;
          upload to config/questbridge/icons on the server)
  mock/   serves the app against the real SNBT, for working without a server
docs/     format research and design notes
```

---

## The editor

Read-only until the **Editing** switch is on, which keeps every input and every
destructive control disabled until someone means it. With it on:

- drag a quest to move it, snapped to FTB's own half-unit grid, over a grid overlay;
- tap an empty spot after **+ Quest** to create one — it opens with the name field
  focused, because naming it is the next thing anyone does;
- edit title, subtitle, description, position, size, shape and icon;
- add and remove dependencies by tapping the other quest on the map, rather than by
  copying a sixteen-digit id around;
- add, edit and delete tasks and rewards of **any** type, addon types the app has
  never heard of included: the form is generated from what the object actually
  carries, plus the type's full field list from `/api/types`, so a field FTB omitted
  at its default can still be set on purpose;
- pick items from all 19,344 in the pack, searched by id, each shown as its icon;
- open **History** and put the whole book back to any earlier point.

Everything updates live for everyone else; the camera stays where you left it, and
the inspector is left alone while you have a field open.

## Status

| | |
|---|---|
| Format research | done — see [`docs/format.md`](docs/format.md) |
| API contract | matches the implementation, this file |
| Icon pipeline | done — 19,344 icons at 64px, 6,272 rendered from real geometry |
| Bridge | read, write, history and restore; in-game change detection — compiles; **has never run against a real server** |
| Editor | reads and edits the whole book, and restores from history; exercised end to end against the mock |
| Deployment | not done — nothing here has run on the VM |
