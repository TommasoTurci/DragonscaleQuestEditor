# Icon and name builders

Generates the editor's item icon set from the pack's mod jars. Runs on a desktop
with the instance installed — never on the server, which has no textures and no
renderer.

```bash
npm install
node build-icons.mjs \
  --mods    "<instance>/minecraft/mods" \
  --vanilla "<prism>/libraries/com/mojang/minecraft/1.21.1/minecraft-1.21.1-client.jar"
```

Output goes to `app/public/icons/` — one PNG per item plus `index.json` mapping item
id to file, kind and dimensions.

## Names

```bash
node build-names.mjs \
  --mods    "<instance>/minecraft/mods" \
  --vanilla "<prism>/libraries/com/mojang/minecraft/1.21.1/minecraft-1.21.1-client.jar"
```

Writes `names.json` beside the icons, mapping item id to display name, read out of
`assets/<ns>/lang/en_us.json` in every jar. A dedicated server has no language file
loaded and cannot tell you an item is called Oak Bench, and nobody composes a quest
book by reading registry ids.

17,062 names come out of 254 lang files. Only 61% of the icon index matches one,
which is not a gap in the lang files: the index is built by walking *model* files
and holds plenty of things that are not items — `minecraft:bow_pulling_0` is a
model for a bow being drawn. The editor takes its item list from the server's own
registry for exactly that reason, and uses these two files only to decorate it.

## Options

| flag | default | |
|---|---|---|
| `--mods` | required | the instance's mods folder |
| `--vanilla` | none | Minecraft client jar. **Give it one.** |
| `--out` | `app/public/icons` | output directory |
| `--size` | `32` | canvas for isometric block cubes |
| `--maxFlat` | `64` | cap for flat sprites; they keep native size below this |

`--vanilla` matters more than it looks. Thousands of modded models point at
`minecraft:` textures, and without the client jar indexed they resolve to nothing.
Adding it took placeholders from 1,585 down to 671.

## How an item becomes an icon

1. Resolve the item model's parent chain, merging each level's `textures` map with
   the child winning, and resolving `#name` indirections.
2. **`layer0` present** → flat sprite. Used whatever the chain resolves to, because
   plenty of mods parent items to their own base model rather than `item/generated`.
   Kept at native resolution; almost all are 16×16, and upscaling only adds bytes.
3. **Geometry anywhere in the chain** → render it. Minecraft item icons are an
   orthographic projection of axis-aligned boxes through the model own
   `display.gui` transform, so `render3d.mjs` rasterizes exactly that: project each
   face quad, texture it nearest-neighbour from its UV rectangle, z-buffer, and
   shade by direction with the game fixed values (up 1.0, sides 0.8/0.6, down 0.5).
   Rendered at 4x and box-filtered down, because rotated edges alias badly at 32px.
   Geometry is inherited, so `cube_all` finds its box in vanilla `block/cube` --
   which is why indexing the client jar matters twice over.
4. **No geometry at all** → isometric cube from whatever face textures exist.
5. **Still nothing** → last resort: Blockbench models number their textures, so try
   `0`, then `particle`, then any texture in the map, and build a single-texture cube.
6. **Nothing at all** → a flat placeholder tile. The editor shows the id beside it.

Animated textures are vertical strips of square frames; only frame 0 is used.

## Current output

| | |
|---|---|
| items | 19,344 |
| flat sprite | 12,123 |
| rendered model | 6,272 |
| isometric cube (no geometry found) | 516 |
| placeholder | 433 (2.2%) |
| payload | ~34 MB of PNG, 2.4 MB index (64px, not committed) |

The 435 placeholders are `builtin/entity` items — chests, beds, banners, shulkers,
skulls — which are rendered by entity code and have no model to composite.

## Known rough edges

These are deliberate. Icons need to make an item recognisable in a picker, not match
the game.

- Tinted items (leather armour, potions) come out grey; tints live outside the model.
- All 316 spawn eggs render identically, since their colours are defined in entity
  code rather than in a texture.

## Not in git

The icon set is **derived from the mod jars**, so it is not committed. It cannot be
lost, only regenerated, and a 34 MB binary payload that changes wholesale on every
pack update is the worst possible thing to put in a repository's history.
`app/public/icons/` is gitignored.

The tablet does not need them locally either — the bridge serves them.

## Regenerating and deploying

After a pack update:

```bash
cd tools/icons && npm install && node build-icons.mjs \
  --size 64 \
  --mods    "<instance>/minecraft/mods" \
  --vanilla "<prism>/libraries/com/mojang/minecraft/1.21.1/minecraft-1.21.1-client.jar"
```

Then copy `app/public/icons/` to the server at:

```
/home/opc/DevDragonscale/config/questbridge/icons/
```

The bridge serves that directory at `/icons/` with a long cache lifetime, so every
editor picks up the new set without anyone installing anything. If the directory is
missing the editor still works: tasks fall back to showing their type and id.
