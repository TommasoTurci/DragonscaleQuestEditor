# Icon builder

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
| payload | ~15 MB of PNG, 2.4 MB index |

The 435 placeholders are `builtin/entity` items — chests, beds, banners, shulkers,
skulls — which are rendered by entity code and have no model to composite.

## Known rough edges

These are deliberate. Icons need to make an item recognisable in a picker, not match
the game.

- Tinted items (leather armour, potions) come out grey; tints live outside the model.
- All 316 spawn eggs render identically, since their colours are defined in entity
  code rather than in a texture.

## Regenerating

Re-run after a pack update. The output is committed, because the person editing on a
tablet has no mods folder to build from.
