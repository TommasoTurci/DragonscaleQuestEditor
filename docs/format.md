# FTB Quests on-disk format

Research notes for Dragonscale: MC 1.21.1, NeoForge 21.1.262, FTB Quests
2101.1.36, plus Quest Enhance, More Quest Types and Quests Visual.

Everything here was read out of the pack's own files and the mods' source, not from
documentation. The bridge means the editor does not parse any of this — but when
something goes wrong on disk, this is the reference.

## Where things live

```
config/ftbquests/quests/          the book
├── data.snbt                      pack-wide settings
├── chapter_groups.snbt            group ordering
├── chapters/*.snbt                one file per chapter
├── reward_tables/*.snbt           loot tables, referenced by id
└── lang/en_us.snbt                every title, subtitle and description

world/<level>/ftbquests/          progress, not content
└── <team-uuid>.snbt               task_progress, started timestamps
```

The book is pack-level and lives in `config/`. The world folder holds only per-team
completion state. Confirmed in `BaseQuestFile.writeDataFull`, which resolves
`data.snbt`, `chapter_groups.snbt`, and each chapter and reward table by path; the
`lang` folder is read there but written by the translation manager.

**This split has already caused one data loss.** A pack sync that shipped the whole
of `config/` overwrote the server's book with a near-empty one from a client
instance. Anything that syncs `config/` must exclude `config/ftbquests/`.

## Identifiers

Every object id is a `long` rendered by `String.format("%016X", id)` — sixteen
uppercase hex digits, zero-padded. Chapter filenames use the lowercase form.

```
id: "4A9AB09E647E7B4C"
dependencies: ["345900C71CE2A226"]
```

New ids are random 64-bit values formatted the same way. Check for collisions across
the whole file set before using one.

## Text is stored separately

Chapter files hold structure; all human-readable strings live in the lang file, keyed
by object id:

```
chapter.3D94C1963CD045BB.title:        "The Beginnings"
quest.345900C71CE2A226.title:          "Obtain Wood"
quest.345900C71CE2A226.quest_subtitle: "The wood is wooding out..."
quest.345900C71CE2A226.quest_desc:     ["The wood is something crazy..."]
```

This is why `QuestObjectBase.writeData` writes only `icon` and `tags` — titles go
through the translation manager. Renaming a quest touches two files.

## The SNBT dialect

From `SNBT.java` in FTB Library:

- Indentation is tabs.
- Key order follows insertion order (`shouldSortKeysOnWrite` defaults false), but
  every file observed is alphabetical, so FTB builds the compounds sorted upstream.
- Empty containers are spaced: `{ }` and `[ ]`, never `{}`.
- A one-element list is inline with no inner padding: `[I;5]`.
- Typed arrays carry a prefix after the bracket: `B;`, `I;`, `L;`.
- Strings are always quoted. Keys are escaped only when needed — `"ftbquests:icon"`
  is quoted because of the colon.
- Number suffixes come from the tag's own `toString()`, hence `0.5d` for doubles.
- Selected compounds are forced inline by a single-line flag, which is why item
  stacks appear as `{ count: 1, id: "minecraft:oak_log" }` on one line.

### Line endings

FTB writes with the host platform's convention: **LF on the Linux server, CRLF on a
Windows client**, content otherwise byte-identical. `.gitattributes` pins `*.snbt` to
LF. Any round-trip comparison must normalise line endings first.

## Omitted means default

FTB writes keys conditionally. `ItemTask` is representative:

| key | written when |
|---|---|
| `item` | always |
| `count` | only when `> 1` |
| `consume_items` | Tristate — omitted at default |
| `only_from_crafting` | Tristate — omitted at default |
| `match_components` | only when not `NONE` |
| `task_screen_only` | only when true |

Read a missing key as its default. Never write a value back that equals the default,
or every opened quest gains a dozen lines of noise.

## Unknown keys must survive

Quest Enhance injects fields into FTB's own compounds through mixins (`QuestMixin`,
`ChapterMixin`, `QuestObjectBaseMixin`). Already present in the Dragonscale book:

```
quest_enhance_decorative_lines
quest_enhance_hidden_dependency_lines
quest_enhance_disable_scroll_paging
```

It also has classes for chapter backgrounds, canvas images, video and prerequisites
that write more as those features get used. Quests Visual is client rendering only,
but its `IconMixin` and `ChapterImageMixin` suggest it extends what an `icon` field
may contain.

Anything reading and rewriting these files must preserve keys it does not recognise.

## Icons are not just item ids

```
icon: {
	components: { "ftbquests:icon": "supplementaries:item/globes/globe_the_world" }
	id: "ftbquests:custom_icon"
}
```

`ftbquests:custom_icon` carries a data component pointing at a texture path rather
than an item. Easier than a normal item icon — no model resolution needed.

## Type inventory

| source | task types | reward types |
|---|---|---|
| FTB Quests | 15 | 13 |
| More Quest Types | 33 | 19 |
| Quest Enhance | adds fields, not types | |
| Quests Visual | client rendering only | |

More Quest Types registers conditionally — `SkillsCompat.isLoaded()`,
`OriginsCompat.isLoaded()`, `LevelZCompat.isLoaded()` and others. Dragonscale has
none of those mods, so a large share of its types never appear.

Do not transcribe these by hand. The bridge introspects the live registries at
runtime; see `/types` in the README.

### In use in the current book

48 quests and 80 tasks in one chapter: `item` ×74, `checkmark` ×3, `break_block` ×3.
Quest fields in use include `dependencies`, `icon`, `shape`, `size`, `icon_scale`,
`invisible`, `hide_until_deps_complete`, `hide_details_until_startable`. Task fields
include `item`, `count`, `value`, `optional_task`, `block_tag`.

### FTB filters are in use

An earlier pass over a two-quest copy of the book concluded no filter appeared
anywhere. The real book uses them heavily — 11 of the tasks sampled. An item task
often matches a filter rather than a literal item:

```
item: { components: { "ftbfiltersystem:filter": "ftbfiltersystem:item_tag(another_furniture:chairs)" }, count: 1, id: "ftbfiltersystem:smart_filter" }
icon: { id: "another_furniture:oak_chair" }
```

Two consequences:

- The filter is **a parsed expression serialized to one string**, as the presence of
  `FilterParser` and `ExpressionFilter` in that mod suggested. The editor can treat
  it as opaque text and add validation later; it does not need a nested model.
- **A task's icon comes from its own `icon` field, not from its item.** The item
  here is `ftbfiltersystem:smart_filter`, which carries the match expression and has
  no meaningful icon of its own, so FTB stores the display icon on the task. Any UI
  that derives an icon from `item.id` shows a filter sprite for a large share of the
  book.

## Item registry

`/kubejs export` is **not** a registry dump on KubeJS 7. It takes `debug`,
`pack-folders`, `pack-zips` or `recipe-schema-json`. The registry listings appear to
be `/kubejs registry <registry>` and `/kubejs tags <registry>` — tab-complete
`/kubejs ` in game to confirm.

The bridge makes this moot by reading the live registry. For tooling that runs off
the jars instead, every `assets/<ns>/models/item/<name>.json` maps to `<ns>:<name>` —
17,527 ids across 122 namespaces for this pack.
