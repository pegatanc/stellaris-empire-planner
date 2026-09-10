# Stellaris Empire Planner

A browser-based empire designer for **Stellaris 4.4.6 "Pegasus"**, built from the
actual game files rather than a wiki — including the enabled mod playset, with a
toggle for every mod.

**Live:** https://pegatanc.github.io/stellaris-empire-planner/

Pick ethics on the real wheel, choose an authority, origin, civics, species
traits and ruler traits, and see immediately which combinations the game would
actually accept and why. Export a block you can paste straight into your own
`user_empire_designs_v3.4.txt` and play.

## What it does

- **Real requirement checking.** Civic, origin and authority `potential` /
  `possible` blocks are evaluated properly, so a blocked pick tells you the
  specific clause that blocks it — "Requires one of: Competitive, Cooperative",
  not a generic error.
- **Honest mod toggles.** Turning a mod off re-merges the dataset the way the
  game's own load order would, then re-checks the build. Point budgets follow:
  Ethics and Civics Classic moves the empire from 3 ethic points / 2 civics to
  5 / 3, and the picker updates accordingly.
- **The ethics wheel**, laid out from the coordinates in
  `interface/customize_species_editors.gui` — inner ring for normal ethics,
  outer ring for fanatic, opposites 180° apart. Modded axes get their own
  spokes automatically, so Ethics and Civics Classic's six axes render as a
  twelve-spoke wheel with `Singular Purpose` and `Gestalt Consciousness` in the
  hub.
- **The actual numbers.** Every ethic, authority, civic, origin and trait lists
  its own modifiers, and authorities add their governance rules (election type
  and term, succession, mandates, agendas). The `tags` block is rendered too -
  that is where the game keeps unlocks the modifiers cannot express, like
  Ecocentrist's Waste Recycling or Industrialist's Thermal Borehole.
- **Secondary species.** Necrophage, Syncretic Evolution, Forever Cruise and
  civics like Driven Assimilator, Rogue Servitor and Bodysnatcher design a
  second species too. When the build calls for one, a section appears under the
  game's own title for it — "Prepatent Species", "Cyborg Species" — with its own
  class, names, portrait and trait budget off its own archetype, the traits the
  civic forces on it locked in, and `secondary_species` written into the export.
- **Where everything came from.** Every civic, origin, ethic, trait and authority
  carries its provenance at the bottom of its card: "Base game", "Added by
  Gigastructural Engineering & More", or "Base game · changed by Ethics and
  Civics Classic". That last one matters — 172 civics and all 17 vanilla ethics
  in this playset are silently retuned by a mod, which looks like vanilla
  otherwise.
- **Live modifier totals** across ethics, authority, origin, civics and traits.
- **Getting around**: sticky section jump-links that mark which section holds a
  problem, a "hide unavailable" filter that cuts 168 civics to the ~50 you can
  actually take, and a running summary of your picks you can click to remove.
- **Find effects** — ask the question backwards. "What in my playset gives
  research speed?" returns every ethic, authority, civic, origin and trait that
  grants it, ranked by how much, with the source mod named. Click a result to
  add it to the build.
- **Roll** — a random empire that is legal by construction, drawn against the
  `random_weight` values in the game files so the odds match what Stellaris
  itself would pick (and a weight of 0 correctly means "never"). Filters for
  Gestalt, Megacorp and Machine. Your names are left alone.
- **Export** to a playable empire block, a share link (the whole build is in the
  URL — no backend), a Markdown build sheet, or JSON.
- **Import** from a share link or straight from a block of your saved designs.
- **Saved builds** in browser storage, with a side-by-side comparison view.

## Mods covered

Of the 18 mods in the playset, six carry empire-creation content:

| Mod | What it contributes |
|---|---|
| Ethics and Civics Classic | 26 ethics (adds socialism/capitalism, green/industrial and focused axes), 9 authorities, 266 civics, 24 origins, 138 governments — **and changes the point budgets** |
| Gigastructural Engineering & More | 20 origins, 14 civics, 82 traits |
| Government Variety Pack | 76 civics, 18 origins, 108 governments |
| Real Space – New Frontiers | 5 origins, 7 traits |
| Monopolist Crisis Path | 1 civic |
| Unlimited Leader Trait Options | level-up trait options only — no effect on empire creation, and the planner says so rather than pretending otherwise |

The other twelve (UI Overhaul Dynamic and its add-ons, Ultimate Automation,
Ideal System Locator, Real Space, RS Planetary Stations, Red V Flag, the two
music mods, Dictatorial Ascendancy) ship no empire-creation data. They still
appear in the sidebar, greyed out and labelled, so the list matches your
launcher.

## Regenerating the data

The site reads static JSON committed to this repo. Re-run the extractor after a
game patch or a change to your mod list:

```bash
python tools/extract.py
```

It reads the game directory and `Documents/Paradox Interactive/Stellaris/dlc_load.json`
for the load order, then writes `data/*.json` and `icons/sprite.png`. Requires
Python 3 and Pillow (for the `.dds` icons); no other dependencies. Override the
paths with `--game` and `--userdir` if your install lives somewhere else.

To work on the site locally, serve it with `python tools/serve.py` rather than
`python -m http.server` — it sends `no-store`, so an edited module actually
reloads instead of the browser quietly running the previous one.

Then check nothing regressed:

```bash
node tools/verify.mjs
node tools/audit.mjs
```

`verify.mjs` pins behaviour with hand-written cases: the vanilla merge (281
civics, 77 origins, 17 ethics, 8 authorities), the mod override behaviour, the
point budgets, and a cross-check against the empires already saved in your own
`user_empire_designs_v3.4.txt`.

`audit.mjs` goes the other way — it re-reads the raw game and mod files and
compares them against what the planner ships and renders, across every entity
rather than a sample. It currently reports:

- every ethics, authority, civic, species, shipset and planet file on disk is indexed
- no unresolved `@variables`, unexpanded `inline_script`s or leftover `$PARAM$`s
- **3360 modifier numbers match their source files exactly**
- 53 of the 55 prescripted empires the game and mods ship validate; the other
  two are the mods' own inconsistencies, pinned as known so the set changing
  still raises a flag
- every blocked pick explains itself — 0 undescribed clauses across 1195
  blocked verdicts
- 2310 rendered descriptions and tags contain no leftover markup

The roller doubles as a fuzz test for the validator: `verify.mjs` rolls 240
empires across two toggle sets and asserts every one is legal and inside every
budget.

## How the merge works

Paradox has two override mechanics and both matter here:

1. A mod file at the **same relative path** replaces the base file wholesale.
   Ethics and Civics Classic ships an entry-less `00_authorities.txt` purely to
   delete the vanilla authorities before re-declaring them in `EaC_authorities.txt`.
2. A definition of the **same id from a different filename** wins by load order.
   The same mod redefines `ethic_authoritarian` from `EaC_ethics.txt`, so base
   `00_ethics.txt` still loads but loses on that id.

A naive union would double every authority and keep the wrong ethics. The
extractor therefore emits every definition tagged with its source, file and a
global ordinal, and the browser re-merges for whatever toggle combination is
active. `common/defines/` is the exception: those merge per key regardless of
filename.

## Limits worth knowing

- **Validation is a faithful subset, not the game engine.** Entries whose
  requirements use constructs outside the documented list syntax are shown with
  an "unverified" badge naming what could not be checked, rather than being
  silently passed. Across all 18 saved empires in the reference file, every
  clause was checkable.
- **Species portraits are not shown.** `gfx/models/portraits/` is 372 MB of 3D
  diffuse/normal/spec textures, not flat art. Portraits are selectable by id;
  species identity is conveyed by class and shipset instead.
- **Conditional modifiers are marked, not merged.** A `triggered_country_modifier`
  whose condition the designer can decide (`is_nomadic`, an ethic, a civic) counts
  toward the totals; one that depends on in-game state is shown greyed and
  labelled rather than silently added.
- **Green means good, not positive.** Plenty of modifiers are better when they
  go down — costs, upkeep, war exhaustion, empire size, damage *taken*. Colouring
  by sign alone paints −75% orbital bombardment damage red and +10% building cost
  green, which is backwards. The extractor works out the 135 keys whose good
  direction is downward, carefully splitting damage dealt (`army_damage_mult`,
  `damage_vs_rival_mult`) from damage received (`army_damage_taken_mult`,
  `planet_orbital_bombardment_damage`). Like the percentage table this is
  inferred, but it is cross-checked against the localised names as an
  independent signal, and the two agree on every key.
- **Percentage vs flat is inferred.** Stellaris ships no file declaring which
  modifiers are percentages, and the `_mult` / `_add` suffix rule leaves 146
  legacy keys undecided. The extractor infers each key's kind from the values the
  game actually ships. If a number ever looks off by 100×, that table is the
  place to look.
- **A species gets exactly one climate preference.** The game enforces that in
  the engine, not the data — 78 of the 79 preference traits declare no
  `opposites` — so the planner carries it as an explicit rule. Verified against
  every shipped empire: none of the 52 prescripted or 18 saved designs breaks it.
- Data is a snapshot of one install. Re-run the extractor when things change.

## Assets and attribution

Icons in `icons/sprite.png` are converted from the installed game and mod files.
They remain the property of **Paradox Interactive** and of the respective mod
authors — Ethics and Civics Classic, Gigastructural Engineering & More,
Government Variety Pack, Real Space – New Frontiers and Monopolist Crisis Path.
This is an unofficial fan tool, not affiliated with or endorsed by Paradox
Interactive. If you are a rights holder and want something removed, open an
issue and it will be taken down.

## Layout

```
index.html            the screen
css/style.css
js/data.js            loading and load-order merging
js/rules.js           requirement evaluator, budgets, government derivation
js/loc.js             game text markup: §colours, £icons£, $nesting$, |formats
js/ui.js              rendering, including the ethics wheel
js/export.js          empire file, share link, build sheet, saved builds
js/empirefile.js      reading and writing user_empire_designs
js/main.js            state and wiring
tools/extract.py      the extractor
tools/clausewitz.py   Clausewitz parser (run it directly for a self-check)
js/roll.js            weighted random empire generation
js/effects.js         reverse modifier index and search
tools/verify.mjs      behavioural test suite
tools/audit.mjs       whole-dataset check against the raw game files
tools/serve.py        no-cache dev server
```
