# Wiki harvesting

Per-item documentation, pulled from wherever each mod's documentation actually
lives, into `app/public/icons/docs.json` for the editor to serve.

```bash
node resolve.mjs          # ask Modrinth where each mod documents itself
node harvest.mjs --wiki <host> --ns <mod>        # MediaWiki
node harvest-github.mjs                          # every GitHub wiki resolve found
node harvest-json.mjs --url <search.json> --ns <mod> --base <site>
node merge.mjs            # combine everything into docs.json
```

`probe.mjs` and `verify.mjs` are the older hostname-guessing path, kept because
`verify.mjs` is what stops a wrong wiki getting in.

## How a page becomes documentation for an item

Everything joins on the **display name**. The Create wiki's "Andesite Alloy" is
`create:andesite_alloy` because `names.json` already read that name out of
Create's own `lang/en_us.json`. It is a far safer join than guessing ids, and a
page with no matching item is kept separately under `topics` — a wiki's page on
Stress is not an item but it is exactly what someone writing a tutorial wants.

## Finding the wikis

Guessing hostnames (`probe.mjs`) found four. Asking Modrinth (`resolve.mjs`)
found 29, including official ones the guessing never would: `wiki.createmod.net`
rather than the Fandom mirror, `quarkmod.net`, eleven GitHub wikis.

**Verify anything guessed.** `spawn.fandom.com` exists and is about a comic
book; attaching that to a Minecraft item would be worse than having nothing.
`verify.mjs` pulls a wiki's titles and counts how many are names of items that
mod actually registers — a wrong wiki scores zero. It rejected 13 of 17
candidates.

## What is actually out there

Of 118 mods that contribute items, 105 are on Modrinth, 29 list a wiki, and ten
have one with per-item pages worth harvesting. That is not a limit of effort:
most of these mods have never had a wiki written, and several that list one
point at a Google Doc, a feature list, or a changelog.

Two sites that list a wiki but have no item pages, checked and skipped:

- **wiki.createmod.net** — the official Create wiki, but it is changelogs,
  CC:Tweaked integration and developer docs. The Fandom mirror has the item
  pages, so that is what is harvested.
- **quarkmod.net** — a feature list, not an item reference.

| source | items |
|---|---|
| minecraft.wiki | 744 |
| alexscaves.wiki.gg | 253 |
| create.fandom.com | 177 |
| iron.wiki | 112 |
| farmersdelight.fandom.com | 103 |
| Supplementaries GitHub wiki | 59 |
| Artifacts GitHub wiki | 44 |
| dungeonsdelight.wiki.gg | 10 |
| Enderscape GitHub wiki | 3 |
| hybrid-aquatic.fandom.com | 2 |

Several GitHub wikis harvest to zero items. They are real wikis, but they are
written as prose pages rather than a heading per item, so there is nothing to
join on. Their pages are still kept as topics.
