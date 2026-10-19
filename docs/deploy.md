# Deploying the bridge

Nothing here has run on the real server yet. This is the plan for the first time,
written while the details were fresh, and the smoke test at the end is the part that
matters most — `/api/edit` is the first thing in this project that can damage the
quest book.

## What goes where

| | |
|---|---|
| `bridge/build/libs/dragonscalebridge-0.1.0.jar` | `/home/opc/DevDragonscale/mods/` |
| `app/public/icons/` (34 MB, ~19k files) | `/home/opc/DevDragonscale/config/questbridge/icons/` |

That is all. **The editor itself is inside the jar** — Gradle bundles
`app/www/index.html` as `questbridge/www/index.html`, and the mod serves it from
there if `config/questbridge/www/` does not exist. So a new version of the editor
means a new jar, not a separate upload, and there is no way to end up with a jar
and a page that disagree.

The jar is only the fallback, though: if `config/questbridge/www/index.html` exists
on the server it wins. That is the escape hatch for a one-line fix at 2am — drop the
file there, reload the browser, no rebuild, no restart. Fold it back into the repo
afterwards or the next jar silently reverts it.

The icons are not in the jar and not in git: they are derived from the pack's mod
jars, so they cannot be lost, only regenerated. See
[`tools/icons/README.md`](../tools/icons/README.md). Without them the editor still
works; tasks fall back to showing their type and id.

**`keep-on-server.txt` in the pack sync already lists `dragonscalebridge-*.jar`**, so
a sync will not delete it. Check that it still does before the next sync.

## Building

```bash
cd bridge && ./gradlew build
```

Needs a JDK 21 (Zulu 21 is what this was built with) and reaches the FTB and
Architectury mavens on first run.

## Uploading

From the Windows clone, with the SSH key the sync tooling already uses:

```bash
scp bridge/build/libs/dragonscalebridge-0.1.0.jar opc@VM_IP:/home/opc/DevDragonscale/mods/
rsync -az --delete app/public/icons/ opc@VM_IP:/home/opc/DevDragonscale/config/questbridge/icons/
```

`rsync` rather than `scp -r` for the icons: 19,000 small files, and after a pack
update only the changed ones move. `--delete` so items removed from the pack stop
being offered in the picker.

Then restart the server. The bridge starts with it; there is no hot install.

## First run

On its first start the mod writes `config/questbridge.properties` with a generated
token:

```properties
port=25580
bind=127.0.0.1
token=<48 hex characters>
```

The token is generated rather than defaulted so an unconfigured install is never
left open. Read it off the server; it is what the editor asks for on first use and
it is remembered per device after that.

### Reaching it

`bind=127.0.0.1` by default. **The bridge speaks plain HTTP**, so on `0.0.0.0` the
token crosses the internet in the clear on every request, and anyone who sees it can
rewrite the quest book.

So, in order of preference:

1. **SSH tunnel.** Nothing to configure, nothing exposed:
   ```bash
   ssh -N -L 25580:127.0.0.1:25580 opc@VM_IP
   ```
   Then `http://127.0.0.1:25580`. Good for a desktop, awkward for a tablet.
2. **A TLS terminator** — Caddy in front of it on the VM, which gets a certificate
   on its own — then `bind` stays loopback and the tablet talks to Caddy.
3. **`bind=0.0.0.0`** and the Oracle Cloud security list opened for the port. This
   is the "type an ip:port on the couch" version that was asked for, and it is the
   one that puts the token on the wire unencrypted. Acceptable for a dev server
   between two people who know it; worth knowing you have chosen it.

Oracle Cloud blocks inbound ports by default in *two* places — the VCN security
list and the instance's own `firewalld`. Both need the port if you go that way.

## Smoke test

In this order, because each step is harder to undo than the last.

```bash
T=<token>; B=http://127.0.0.1:25580
curl -s -H "Authorization: Bearer $T" $B/api/health
```
Expect `{"ok":true,...,"bookLoaded":true}`. `bookLoaded:false` means FTB had not
finished loading; wait and retry.

```bash
curl -s -H "Authorization: Bearer $T" $B/api/book | head -c 400
curl -s -H "Authorization: Bearer $T" $B/api/types | head -c 400
```
`/api/types` is the one that proves the introspection works against the real
registries rather than against the mock's guesses — it should list far more task
types than the three this book happens to use, including the addon ones.

Open `http://127.0.0.1:25580/` and check the book draws with icons. Everything so
far is read-only.

**Then, and only then, one edit.** Pick a quest that does not matter, note its `x`,
and move it a little:

```bash
curl -s -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"baseVersion":1,"edits":[{"op":"set","target":"<id>","path":"data.x","value":<x+1>,"type":"double"}]}' \
  $B/api/edit
```

Then check three things, in this order:

1. The quest moved in game, for a player with the book open in edit mode.
2. About eight seconds later, a commit appeared:
   `git -C /home/opc/DevDragonscale/config/ftbquests log --oneline | head`
3. The file on disk says `x: <x+1>d` — **with the `d`**. A `double` written as an
   int is the failure mode that would quietly corrupt the book, and this is the
   cheapest place to catch it.

If all three hold, the rest of the write path rests on the same two mechanisms.

## Rolling back

The bridge is one jar and it owns no state the game needs. Delete it from `mods/`
and restart, and the server is exactly as it was — the quest folder keeps its git
history and its `ftbquests.before-*` copies either way.

If an edit goes wrong while it is installed, the History dialog restores. If the
bridge itself is the problem:

```bash
cd /home/opc/DevDragonscale/config/ftbquests && git log --oneline
git read-tree -u --reset <commit>      # then restart the server
```

## Known unknowns

Things that are reasoned about but not observed, and so are worth watching on the
first run:

- **Client connection.** The mod is server-only and registers no network payloads,
  so NeoForge should not demand it on clients. If a client is refused with a mod
  mismatch, that assumption is wrong.
- **`readDataFull` on a live server** (the restore path) has never been called
  outside FTB's own startup. Try a restore while nobody is mid-quest.
- **The in-game change watcher** fingerprints the whole book every two seconds while
  an editor is connected. On this book that is nothing; if the pack's book grows to
  thousands of quests, check it is still nothing before assuming it is.
- **`/api/types` constructs a probe instance of every registered type.** An addon
  type that misbehaves in its constructor is reported as `introspectionFailed`
  rather than taking the endpoint down, but it has only ever been run against the
  types this book uses.
