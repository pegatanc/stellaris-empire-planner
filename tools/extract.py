#!/usr/bin/env python3
"""Extract Stellaris empire-creation data (base game + mods) into static JSON.

Run this whenever the game or the mod playset changes:

    python tools/extract.py

Output lands in ../data/ relative to this file. Nothing here runs in CI or in the
browser - the site only ever reads the committed JSON.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import OrderedDict, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clausewitz as cw  # noqa: E402

# --------------------------------------------------------------------------
# Source discovery
# --------------------------------------------------------------------------

DEFAULT_GAME = r"C:\Program Files (x86)\Steam\steamapps\common\Stellaris"


def default_userdir():
    return Path.home() / "Documents" / "Paradox Interactive" / "Stellaris"


def read_text(path):
    with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
        return fh.read()


def parse_descriptor(path):
    """Pull name/path out of a .mod descriptor."""
    blk = cw.parse(read_text(path))
    return blk.get("name"), blk.get("path")


def discover_sources(game_dir, user_dir):
    """Base game first, then every enabled mod in launcher load order."""
    sources = [{
        "id": "base",
        "name": "Stellaris (base game)",
        "root": str(game_dir),
        "order": 0,
        "steam_id": None,
    }]
    load_file = user_dir / "dlc_load.json"
    if not load_file.exists():
        print(f"  ! no dlc_load.json at {load_file} - base game only")
        return sources

    enabled = json.loads(read_text(load_file)).get("enabled_mods", [])
    for i, rel in enumerate(enabled, start=1):
        desc = user_dir / rel
        if not desc.exists():
            print(f"  ! missing mod descriptor {rel}")
            continue
        name, root = parse_descriptor(desc)
        if not root:
            print(f"  ! descriptor {rel} has no path=")
            continue
        root_path = Path(root)
        if not root_path.is_absolute():
            root_path = user_dir / root
        if not root_path.exists():
            print(f"  ! mod root missing for {name}: {root_path}")
            continue
        stem = Path(rel).stem
        sources.append({
            "id": stem.replace("ugc_", "") or stem,
            "name": name or stem,
            "root": str(root_path),
            "order": i,
            "steam_id": stem[4:] if stem.startswith("ugc_") else None,
        })
    return sources


# --------------------------------------------------------------------------
# What we scan
# --------------------------------------------------------------------------

# category -> (relative dir, recurse into subdirs)
SCAN_DIRS = OrderedDict([
    ("ethics",             ("common/ethics", False)),
    ("ethic_categories",   ("common/ethic_categories", False)),
    ("authorities",        ("common/governments/authorities", False)),
    ("civics",             ("common/governments/civics", False)),
    ("governments",        ("common/governments", False)),
    ("species_archetypes", ("common/species_archetypes", False)),
    ("species_classes",    ("common/species_classes", False)),
    ("traits",             ("common/traits", False)),
    ("graphical_culture",  ("common/graphical_culture", False)),
    ("planet_classes",     ("common/planet_classes", False)),
    ("portrait_sets",      ("common/portrait_sets", False)),
    ("name_lists",         ("common/name_lists", False)),
])

# Bulky or purely-AI fields. Dropping them keeps the payload sane without
# touching anything the designer screen actually shows.
DROP_KEYS = frozenset({
    "ai_weight", "selectable_weight", "assembly_score",
    "slave_cost", "ship_lighting", "ship_selection_weight", "ship_kinds",
    "on_gained_effect", "pop_attraction", "country_attraction",
    "pop_attraction_tag", "leader_background_job_weight",
    "trade_acceptance_weight", "ethics_to_prefer", "preferred_ethics_weight",
    # triggered_country_modifier and triggered_modifier are kept: they carry
    # real empire stats (a vanilla ethic hides a -40% starbase influence cost
    # behind `is_nomadic = no`), and their potential blocks are often evaluable
    # at design time. The rest depend on in-game state the designer has not got.
    "triggered_pop_group_modifier", "triggered_planet_growth_habitability_modifier",
    "triggered_species_modifier", "triggered_planet_pop_group_modifier_for_species",
    "triggered_leader_modifier",
    "triggered_councilor_modifier", "triggered_planet_modifier",
    "triggered_sector_modifier", "triggered_background_planet_modifier",
    "triggered_self_modifier", "triggered_fleet_modifier", "triggered_army_modifier",
    "move_pop_sound_effect", "entity", "graphical_culture_entity",
})

# Files inside a scanned dir that are documentation, not data.
DOC_FILE = re.compile(r"(readme|documentation|_example)", re.I)

MODIFIER_KEYS = (
    "modifier", "country_modifier", "self_modifier", "councilor_modifier",
    "planet_modifier", "sector_modifier", "fleet_modifier", "army_modifier",
    "system_modifier", "galcom_modifier", "federation_modifier",
    "background_planet_modifier", "pop_group_modifier",
)

# Defines that change what the designer lets you spend.
DEFINE_KEYS = frozenset({
    "ETHOS_MAX_POINTS", "GOVERNMENT_CIVIC_POINTS_BASE", "MIN_ETHIC_POINTS",
    "DEFAULT_ORIGIN", "DEFAULT_TRAIT_OPTIONS_ON_LEVEL_UP",
    "NON_PARAGON_TRAIT_OPTIONS_ON_LEVEL_UP", "NUM_DESTINY_TRAIT_OPTIONS",
    "LEADER_MAX_SKILL_CAP",
})


def list_files(root, rel_dir, recurse, exts=(".txt",)):
    base = Path(root) / rel_dir
    if not base.is_dir():
        return []
    out = []
    if recurse:
        it = base.rglob("*")
    else:
        it = base.iterdir()
    for p in it:
        if p.is_file() and p.suffix.lower() in exts:
            out.append(p)
    return sorted(out, key=lambda p: str(p).lower())


# --------------------------------------------------------------------------
# Macro layers: @scripted_variables and inline_script
# --------------------------------------------------------------------------

# ponytail: both macro tables are built from the FULL playset rather than
# per-toggle. Mods do not redefine each other's variables or trait/* inline
# scripts in this playset, and these only feed numbers and icon names - so
# per-source resolution would be real work for no observable difference.

def build_variables(sources):
    table = {}
    for src in sources:
        for path in list_files(src["root"], "common/scripted_variables", False):
            blk = cw.parse(read_text(path))
            for key, _op, val in blk.items:
                if key.startswith("@") and isinstance(val, str):
                    table[key] = val
    # Variables may point at other variables; a couple of passes settles it.
    for _ in range(4):
        changed = False
        for key, val in list(table.items()):
            if isinstance(val, str) and val.startswith("@") and val in table:
                table[key] = table[val]
                changed = True
        if not changed:
            break
    return table


def build_inline_scripts(sources):
    table = {}
    for src in sources:
        for path in list_files(src["root"], "common/inline_scripts", True):
            rel = path.relative_to(Path(src["root"]) / "common/inline_scripts")
            key = rel.with_suffix("").as_posix()
            table[key] = cw.parse(read_text(path))
    return table


_PARAM = re.compile(r"\$([A-Za-z_0-9]+)(?:\|([^$]*))?\$")


def substitute(text, params):
    if params is None or not isinstance(text, str) or "$" not in text:
        return text

    def repl(m):
        name, default = m.group(1), m.group(2)
        if name in params:
            return str(params[name])
        return default if default is not None else m.group(0)

    return _PARAM.sub(repl, text)


def expand_inline(block, scripts, params=None, depth=0):
    """Splice inline_script contents in place, substituting $PARAMS$."""
    out = cw.Block()
    for key, op, val in block.items:
        if key == "inline_script":
            if depth > 12:
                continue
            if isinstance(val, cw.Block):
                path = substitute(val.get("script", ""), params)
                sub = {
                    k: substitute(v, params)
                    for k, _o, v in val.items
                    if k != "script" and isinstance(v, str)
                }
            else:
                path, sub = substitute(val, params), {}
            target = scripts.get(path)
            if target is None:
                continue
            expanded = expand_inline(target, scripts, sub, depth + 1)
            out.items.extend(expanded.items)
            out.bare.extend(expanded.bare)
            continue
        new_key = substitute(key, params)
        if isinstance(val, cw.Block):
            new_val = expand_inline(val, scripts, params, depth)
        else:
            new_val = substitute(val, params)
        out.items.append((new_key, op, new_val))
    out.bare.extend(substitute(b, params) for b in block.bare)
    return out


# --------------------------------------------------------------------------
# Entity extraction
# --------------------------------------------------------------------------

def slim_random_weight(obj):
    """Keep only `base` from random_weight.

    That number is what the game rolls against, and it doubles as the rarity
    tier (5 common / 3 uncommon / 1 rare). The `modifier` sub-blocks alongside
    it are AI weighting - up to 25 lines each - and are no use here.
    """
    weight = obj.get("random_weight")
    if isinstance(weight, list):
        weight = weight[0] if weight else None
    if isinstance(weight, dict):
        base = weight.get("base")
        if isinstance(base, str):
            obj["random_weight"] = base
            return
    if isinstance(weight, str):
        return
    obj.pop("random_weight", None)


def slim_portrait_set(obj):
    """Portrait sets are mostly giant id lists; keep only what a picker needs."""
    portraits = []

    def collect(node):
        if isinstance(node, dict):
            lst = node.get("__list")
            if isinstance(lst, list):
                portraits.extend(lst)
            for k, v in node.items():
                if k in ("portraits", "conditional_portraits"):
                    collect(v)
        elif isinstance(node, list):
            for v in node:
                collect(v)

    collect({"portraits": obj.get("portraits"), "conditional_portraits": obj.get("conditional_portraits")})
    out = {"portraits": sorted(set(portraits))}
    if "species_class" in obj:
        out["species_class"] = obj["species_class"]
    return out


def extract_entities(sources, variables, scripts):
    entities = {cat: [] for cat in SCAN_DIRS}
    entities["origins"] = []
    entities["species_traits"] = []
    entities["leader_traits"] = []
    file_providers = defaultdict(list)
    rel_paths = set()
    stats = defaultdict(int)

    parsed_files = []  # (src_index, relpath, category, Block)

    for src_index, src in enumerate(sources):
        root = Path(src["root"])
        for cat, (rel_dir, recurse) in SCAN_DIRS.items():
            for path in list_files(root, rel_dir, recurse):
                relpath = path.relative_to(root).as_posix()
                # common/governments holds authorities/ and civics/ as subdirs;
                # only the loose .txt files there are governments.
                if cat == "governments" and relpath.count("/") != 2:
                    continue
                if DOC_FILE.search(path.name):
                    continue
                rel_paths.add(relpath)
                if src["id"] not in file_providers[relpath]:
                    file_providers[relpath].append(src["id"])
                parsed_files.append((src_index, relpath, cat, path))

    # Global load order: source order first, then filename order within a source.
    rel_index = {rel: i for i, rel in enumerate(sorted(rel_paths))}

    # Parse everything first. Data files define their own @variables inline -
    # common/species_archetypes/00_species_archetypes.txt sets @machine_trait_points
    # at the top of the same file it uses it in - so the variable table has to be
    # complete before any value is resolved.
    blocks = []
    for src_index, relpath, cat, path in parsed_files:
        src_id = sources[src_index]["id"]
        try:
            block = cw.parse(read_text(path))
        except Exception as exc:  # noqa: BLE001 - one bad file must not kill the run
            print(f"  ! parse failed {relpath} ({src_id}): {exc}")
            stats["parse_errors"] += 1
            continue
        for key, _op, val in block.items:
            if key.startswith("@") and isinstance(val, str):
                variables.setdefault(key, val)
        blocks.append((src_index, relpath, cat, block))

    for src_index, relpath, cat, block in blocks:
        src_id = sources[src_index]["id"]
        ordinal = src_index * 1_000_000 + rel_index[relpath]

        # Last definition of a key inside one file wins (EaC declares
        # civic_corporate_sovereign_guardianship twice).
        seen_in_file = {}
        for key, _op, val in block.items:
            if not isinstance(val, cw.Block) or key.startswith("@") or not key:
                continue
            seen_in_file[key] = val

        for key, val in seen_in_file.items():
            expanded = expand_inline(val, scripts)
            if cat == "portrait_sets":
                data = slim_portrait_set(cw.to_obj(expanded, resolve=variables))
            elif cat == "name_lists":
                data = {}          # ids only; the pools are huge and unused here
            else:
                data = cw.to_obj(expanded, resolve=variables, drop=DROP_KEYS)
                slim_random_weight(data)

            target = cat
            if cat == "civics" and data.get("is_origin") == "yes":
                target = "origins"
            elif cat == "traits":
                target = "leader_traits" if is_leader_trait(key, data) else "species_traits"

            entities[target].append({
                "id": key,
                "src": src_id,
                "file": relpath,
                "ord": ordinal,
                "data": data,
            })
            stats[target] += 1

    entities.pop("traits", None)
    entities.pop("civics_raw", None)
    return entities, dict(file_providers), stats


LEADER_MARKERS = (
    "leader_class", "leader_trait_type", "starting_ruler_trait",
    "leader_potential_add", "councilor_modifier", "leader_trait_rarity",
    "replace_traits", "veteran_class_trait", "destiny_trait",
)


def is_leader_trait(trait_id, data):
    if trait_id.startswith("leader_trait_"):
        return True
    if any(k in data for k in LEADER_MARKERS):
        return True
    # Species traits always declare who may take them.
    return not ("allowed_archetypes" in data or "species_class" in data
                or "species_potential_add" in data or "species_possible_add" in data)


# --------------------------------------------------------------------------
# Defines - key-level override, ignoring file replacement
# --------------------------------------------------------------------------

MODIFIER_BLOCK_FIELDS = MODIFIER_KEYS + (
    "triggered_country_modifier", "triggered_modifier",
)
NON_MODIFIER_KEYS = frozenset({"__list", "custom_tooltip", "potential", "desc", "text"})


# Flat amounts that nonetheless take fractional values, so the rule above would
# read them as multipliers. Political power is the only family in this playset:
# Ethics and Civics Classic hands out +9 ruler political power while other
# civics shift it by 0.25, and both are flat additions. Auditing every key that
# was classed as a percentage yet carries a value of 3 or more turns up only
# these three plus army_health / army_morale, which really are percentages.
FLAT_BY_NAME = re.compile(r"_political_power$|^add_attunement_|_pool_size$")


def classify_modifiers(entities):
    """Decide which modifier keys the UI should render as percentages.

    The engine formats from the identifier suffix - `_mult` is a percentage,
    `_add` is flat - but 146 legacy keys carry neither, and they are genuinely
    mixed: pop_happiness = 0.05 means +5% while max_rivalries = 2 means two more
    rivals. There is no data file that says which is which, so infer it from the
    values actually shipped: a fractional value below 1 is a multiplier, whole
    numbers are counts.
    """
    observed = defaultdict(list)

    def take(block):
        if not isinstance(block, dict):
            return
        for key, val in block.items():
            if key in NON_MODIFIER_KEYS or not isinstance(val, str):
                continue
            try:
                observed[key].append(float(val))
            except ValueError:
                pass

    for items in entities.values():
        for ent in items:
            for field in MODIFIER_BLOCK_FIELDS:
                value = ent["data"].get(field)
                for block in (value if isinstance(value, list) else [value]):
                    take(block)

    kinds = {}
    for key, values in observed.items():
        if key.endswith("_mult"):
            kinds[key] = "pct"
        elif key.endswith("_add") or FLAT_BY_NAME.search(key):
            kinds[key] = "flat"
        elif any(v != int(v) and abs(v) < 1 for v in values):
            kinds[key] = "pct"
        else:
            kinds[key] = "flat"
    return kinds




def extract_defines(sources):
    out = []
    for src in sources:
        for path in list_files(src["root"], "common/defines", False):
            blk = cw.parse(read_text(path))
            found = {}

            def walk(b):
                for k, _op, v in b.items:
                    if isinstance(v, cw.Block):
                        walk(v)
                    elif k in DEFINE_KEYS:
                        found[k] = v

            walk(blk)
            if found:
                out.append({
                    "src": src["id"],
                    "order": src["order"],
                    "file": Path(path).name,
                    "values": found,
                })
    out.sort(key=lambda d: d["order"])
    return out


# --------------------------------------------------------------------------
# Localisation
# --------------------------------------------------------------------------

def load_localisation(sources, language="english"):
    """Returns {key: [(src_id, value), ...]} in ascending precedence order."""
    layered = defaultdict(list)
    for src in sources:
        root = Path(src["root"]) / "localisation"
        if not root.is_dir():
            continue
        regular, replace = [], []
        for path in root.rglob("*.yml"):
            name = path.name.lower()
            if f"_l_{language}" not in name:
                continue
            parts = [p.lower() for p in path.relative_to(root).parts]
            (replace if "replace" in parts else regular).append(path)
        merged = {}
        # replace/ wins inside a single source
        for path in sorted(regular) + sorted(replace):
            try:
                merged.update(cw.parse_loc(read_text(path)))
            except Exception as exc:  # noqa: BLE001
                print(f"  ! loc failed {path.name}: {exc}")
        for key, val in merged.items():
            stack = layered[key]
            if not stack or stack[-1][1] != val:
                stack.append((src["id"], val))
    return layered


_LOC_REF = re.compile(r"\$([A-Za-z0-9_.\-']+)(?:\|[^$]*)?\$")
# Scripted-loc links: ['concept_x'] and scoped forms like ['technology:tech_x'].
# These name a real loc key, so the filter has to follow them or the rendered
# text loses the word entirely.
_LOC_BRACKET = re.compile(r"\['([A-Za-z0-9_.:\-]+)'\]")


def _referenced_keys(value):
    keys = set(_LOC_REF.findall(value))
    for raw in _LOC_BRACKET.findall(value):
        name = raw.split(':')[-1]
        keys.add(raw)
        keys.add(name)
        keys.add(f"concept_{name}")
    return keys


def collect_loc_keys(entities):
    """Every loc key the site could need, seeded from the extracted data."""
    keys = set()
    text_fields = (
        "description", "negative_description", "custom_tooltip",
        "custom_tooltip_with_modifiers", "name", "text", "title",
        "moddable_conditions_custom_tooltip", "ruler_title", "ruler_title_female",
        "heir_title", "heir_title_female", "short_name",
    )

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k in text_fields and isinstance(v, str):
                    keys.add(v)
                elif k in text_fields and isinstance(v, list):
                    keys.update(x for x in v if isinstance(x, str))
                if k in ("tags", "localized_tags") and isinstance(v, dict):
                    keys.update(x for x in v.get("__list", []) if isinstance(x, str))
                if k in MODIFIER_KEYS and isinstance(v, dict):
                    for mod_key in v:
                        if mod_key.startswith("__"):
                            continue
                        keys.add("mod_" + mod_key)
                        keys.add("MOD_" + mod_key.upper())
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    for cat, items in entities.items():
        for ent in items:
            keys.add(ent["id"])
            keys.add(ent["id"] + "_desc")
            if cat in ("species_classes", "name_lists"):
                keys.add(ent["id"] + "_plural")
            walk(ent["data"])
    return keys


def resolve_loc(layered, seeds, max_depth=6):
    """Keep only reachable keys, following $NESTED$ references."""
    wanted = set(seeds)
    for _ in range(max_depth):
        extra = set()
        for key in wanted:
            for _src, val in layered.get(key, ()):
                extra.update(_referenced_keys(val))
        new = extra - wanted
        if not new:
            break
        wanted |= new

    single, multi = {}, {}
    for key in sorted(wanted):
        stack = layered.get(key)
        if not stack:
            continue
        if len(stack) == 1:
            single[key] = stack[0][1]
        else:
            multi[key] = [[src, val] for src, val in stack]
    return single, multi


# --------------------------------------------------------------------------
# Loose option lists pulled from prescripted empires
# --------------------------------------------------------------------------

def extract_options(sources, game_dir):
    rooms, voices, name_lists, ship_prefixes = set(), set(), set(), set()
    for src in sources:
        for path in list_files(src["root"], "prescripted_countries", False):
            blk = cw.parse(read_text(path))
            for _key, _op, val in blk.items:
                if not isinstance(val, cw.Block):
                    continue
                for field, bucket in (("room", rooms), ("advisor_voice_type", voices)):
                    got = val.get(field)
                    if isinstance(got, str):
                        bucket.add(got)
                species = val.get("species")
                if isinstance(species, cw.Block):
                    nl = species.get("name_list")
                    if isinstance(nl, str):
                        name_lists.add(nl)

    flags = {}
    flag_root = Path(game_dir) / "flags"
    if flag_root.is_dir():
        for cat_dir in sorted(flag_root.iterdir()):
            if cat_dir.is_dir():
                files = sorted(p.name for p in cat_dir.glob("*.dds"))
                if files:
                    flags[cat_dir.name] = files
    colors = []
    colors_file = flag_root / "colors.txt"
    if colors_file.exists():
        blk = cw.parse(read_text(colors_file))
        colors = [k for k, _op, v in blk.items if isinstance(v, cw.Block)]

    # host_has_dlc compares against the `name` field of dlc/<folder>/*.dlc.
    dlcs = []
    dlc_root = Path(game_dir) / "dlc"
    if dlc_root.is_dir():
        for meta_file in sorted(dlc_root.glob("*/*.dlc")):
            blk = cw.parse(read_text(meta_file))
            name = blk.get("name")
            if isinstance(name, str):
                dlcs.append({"id": meta_file.parent.name, "name": name})

    return {
        "rooms": sorted(rooms),
        "advisor_voices": sorted(voices),
        "prescripted_name_lists": sorted(name_lists),
        "flag_categories": flags,
        "flag_colors": colors,
        "dlcs": dlcs,
    }


# --------------------------------------------------------------------------
# Icons
#
# Game art is .dds but uncompressed 32-bit BGRA at ~29-44px, so Pillow reads it
# directly. Everything the site needs goes into one sprite sheet - ~2000 separate
# requests on GitHub Pages would be far slower than a single PNG.
# --------------------------------------------------------------------------

# Frame/decoration layers in a Galactic Paragons composite icon. The real icon is
# whichever layer is not one of these.
ICON_DECORATIONS = frozenset({
    "GFX_trait_bg", "GFX_trait_councilor", "GFX_trait_disabled",
    "GFX_trait_no_council", "GFX_trait_bg_negative",
})
ICON_DECORATION_PREFIXES = (
    "GFX_trait_tier_", "GFX_trait_rarity_", "GFX_trait_subclass_",
    "GFX_trait_subtitle_",
)

ICON_CONVENTIONS = {
    "ethics": ["gfx/interface/icons/ethics/{id}.dds"],
    "civics": ["gfx/interface/icons/governments/civics/{id}.dds"],
    "origins": ["gfx/interface/icons/origins/{id}.dds",
                "gfx/interface/icons/governments/civics/{id}.dds"],
    "authorities": ["gfx/interface/icons/governments/authorities/{id}.dds"],
    "species_traits": ["gfx/interface/icons/traits/{id}.dds"],
    "leader_traits": ["gfx/interface/icons/traits/leader_trait_icons/{short}.dds",
                      "gfx/interface/icons/traits/leader_traits/{id}.dds",
                      "gfx/interface/icons/traits/{id}.dds"],
    "planet_classes": [],
    "species_classes": [],
    "graphical_culture": [],
}

MAX_ICON_PX = 64

TEXT_ICON_PATTERNS = (
    "GFX_text_{}",
    "GFX_text_resource_{}",
    "GFX_{}",
    "GFX_resource_{}",
    "gfx/interface/icons/jobs/{}.dds",
    "gfx/interface/icons/resources/{}.dds",
    "gfx/interface/icons/modifiers/{}.dds",
    "gfx/interface/icons/text_icons/icon_text_{}.dds",
)


def arr(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def build_sprites(sources):
    """Map GFX_* sprite names onto their texture files."""
    out = {}

    def walk(block):
        for _k, _op, val in block.items:
            if not isinstance(val, cw.Block):
                continue
            name, tex, frames, sheet, frame = None, None, 1, None, 1
            for key, _o, v in val.items:
                low = key.lower()
                if low == "name" and isinstance(v, str):
                    name = v
                elif low == "texturefile" and isinstance(v, str):
                    tex = v
                elif low == "sprite_sheet_sprite_type" and isinstance(v, str):
                    sheet = v
                elif low in ("noofframes", "default_frame") and isinstance(v, str):
                    try:
                        n = int(v)
                    except ValueError:
                        n = None
                    if n is not None:
                        if low == "noofframes":
                            frames = n
                        else:
                            frame = n
            if name and tex:
                out[name] = {"file": tex.replace("\\", "/").lower(), "frames": frames}
            elif name and sheet:
                # An entry cut out of a strip, e.g. GFX_planet_type_desert.
                out[name] = {"sheet": sheet, "frame": frame}
            walk(val)

    for src in sources:
        for path in list_files(src["root"], "interface", True, exts=(".gfx",)):
            try:
                walk(cw.parse(read_text(path)))
            except Exception as exc:  # noqa: BLE001
                print(f"  ! gfx failed {path.name}: {exc}")
    return out


def build_gfx_index(sources):
    """Relative gfx path -> absolute file, later sources overriding earlier."""
    index = {}
    for src in sources:
        root = Path(src["root"])
        base = root / "gfx" / "interface"
        if not base.is_dir():
            continue
        for path in base.rglob("*.dds"):
            index[path.relative_to(root).as_posix().lower()] = path
    return index


def _icon_candidates(spec):
    """Icon fields are a path, a GFX_ name, or a layered composite."""
    if isinstance(spec, str):
        return [spec]
    if isinstance(spec, dict):
        out = []
        for layer in arr(spec.get("layer")):
            if not isinstance(layer, dict):
                continue
            name = layer.get("icon")
            if not isinstance(name, str) or name in ICON_DECORATIONS:
                continue
            if name.startswith(ICON_DECORATION_PREFIXES):
                continue
            out.append(name)
        return out
    return []


def _lookup_icon(name, sprites, gfx, depth=0):
    """Returns (path, frame, total_frames) or None. Frames are 1-based."""
    if not isinstance(name, str) or not name or depth > 4:
        return None
    if name.lower().endswith(".dds"):
        path = gfx.get(name.replace("\\", "/").lower())
        return (path, 1, 1) if path else None
    sprite = sprites.get(name)
    if not sprite:
        return None
    if "sheet" in sprite:
        parent = _lookup_icon(sprite["sheet"], sprites, gfx, depth + 1)
        if not parent:
            return None
        return (parent[0], sprite["frame"], parent[2])
    path = gfx.get(sprite["file"])
    return (path, 1, sprite.get("frames", 1)) if path else None


def resolve_icons(entities, loc_single, loc_multi, sprites, gfx):
    """key -> absolute .dds path for everything the UI can display."""
    wanted = {}
    missing = defaultdict(list)

    for cat, items in entities.items():
        conventions = ICON_CONVENTIONS.get(cat)
        if conventions is None:
            continue
        for ent in items:
            key = ent["id"]
            if key in wanted:
                continue
            short = key[len("leader_trait_"):] if key.startswith("leader_trait_") else key
            candidates = _icon_candidates(ent["data"].get("icon"))
            candidates += [c.format(id=key, short=short) for c in conventions]
            for cand in candidates:
                found = _lookup_icon(cand, sprites, gfx)
                if found:
                    wanted[key] = found
                    break
            else:
                if conventions:
                    missing[cat].append(key)

    # Modifier icons, for the running-totals panel. Most modifier keys ship no
    # icon of their own, so the panel is text-first by necessity.
    for key in list(loc_single) + list(loc_multi):
        if key.startswith("mod_"):
            found = gfx.get(f"gfx/interface/icons/modifiers/{key}.dds")
            if found:
                wanted[key] = (found, 1, 1)

    # Inline £icon£ tokens used by the strings we kept.
    tokens = set()
    for value in list(loc_single.values()) + [v[-1][1] for v in loc_multi.values()]:
        tokens.update(re.findall(r"£([A-Za-z0-9_]+)", value))
    # £token£ does not have one naming rule. Resources, jobs and modifiers each
    # live somewhere different, and a token that resolves to nothing renders as
    # a blank gap mid-sentence. This chain covers 163 of the 173 tokens the kept
    # strings actually reference.
    for tok in tokens:
        for pattern in TEXT_ICON_PATTERNS:
            found = _lookup_icon(pattern.format(tok), sprites, gfx)
            if found:
                wanted["text_" + tok] = found
                break

    return wanted, missing


def build_sprite_sheet(wanted, out_png):
    """Shelf-pack every icon into one PNG. Returns {key: [x, y, w, h]}."""
    try:
        from PIL import Image
    except ImportError:
        print("  ! Pillow not available - skipping icons")
        return None, (0, 0)

    loaded = []
    for key, (path, frame, frames) in sorted(wanted.items()):
        try:
            img = Image.open(path)
            img.load()
            img = img.convert("RGBA")
        except Exception:  # noqa: BLE001 - a handful of files are malformed
            continue
        if frames > 1:
            # Horizontal strip; Paradox frame numbers are 1-based.
            fw = img.width // frames
            if fw < 1:
                continue
            left = max(0, min(frames - 1, frame - 1)) * fw
            img = img.crop((left, 0, left + fw, img.height))
        if max(img.size) > MAX_ICON_PX:
            scale = MAX_ICON_PX / max(img.size)
            img = img.resize(
                (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                Image.LANCZOS,
            )
        loaded.append((key, img))

    if not loaded:
        return None, (0, 0)

    loaded.sort(key=lambda kv: (-kv[1].height, kv[0]))
    sheet_w = 1024
    pad = 1
    x = y = row_h = 0
    placements = {}
    for key, img in loaded:
        if x + img.width + pad > sheet_w:
            x = 0
            y += row_h + pad
            row_h = 0
        placements[key] = (x, y, img.width, img.height)
        x += img.width + pad
        row_h = max(row_h, img.height)
    sheet_h = y + row_h + pad

    sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))
    for key, img in loaded:
        px, py, _w, _h = placements[key]
        sheet.paste(img, (px, py))

    out_png.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_png, optimize=True)
    return {k: list(v) for k, v in placements.items()}, (sheet_w, sheet_h)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def write_json(path, obj, label):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
    size = path.stat().st_size
    print(f"  {label:<22} {size/1024:8.1f} KB  {path.name}")
    return size


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--game", default=os.environ.get("STELLARIS_DIR", DEFAULT_GAME))
    ap.add_argument("--userdir", default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    game_dir = Path(args.game)
    user_dir = Path(args.userdir) if args.userdir else default_userdir()
    out_dir = Path(args.out) if args.out else Path(__file__).resolve().parent.parent / "data"

    if not game_dir.is_dir():
        ap.error(f"game directory not found: {game_dir}")

    started = time.time()
    print(f"game    {game_dir}")
    print(f"userdir {user_dir}")

    version = "unknown"
    launcher = game_dir / "launcher-settings.json"
    if launcher.exists():
        version = json.loads(read_text(launcher)).get("version", "unknown")
    print(f"version {version}")

    sources = discover_sources(game_dir, user_dir)
    print(f"\nsources ({len(sources)}):")
    for src in sources:
        print(f"  {src['order']:>2}  {src['id']:<14} {src['name']}")

    print("\nbuilding macro tables...")
    variables = build_variables(sources)
    scripts = build_inline_scripts(sources)
    print(f"  {len(variables)} scripted variables, {len(scripts)} inline scripts")

    print("\nextracting entities...")
    entities, file_providers, stats = extract_entities(sources, variables, scripts)
    for cat in sorted(entities):
        uniq = len({e['id'] for e in entities[cat]})
        print(f"  {cat:<20} {len(entities[cat]):>5} defs  {uniq:>5} unique ids")
    if stats.get("parse_errors"):
        print(f"  ! {stats['parse_errors']} files failed to parse")

    defines = extract_defines(sources)
    print(f"\ndefines: {len(defines)} contributing files")
    for d in defines:
        print(f"  {d['src']:<14} {d['file']:<34} {d['values']}")

    print("\nlocalisation...")
    layered = load_localisation(sources)
    seeds = collect_loc_keys(entities)
    loc, loc_multi = resolve_loc(layered, seeds)
    print(f"  {len(layered)} keys available, {len(seeds)} seeds"
          f" -> {len(loc)} single + {len(loc_multi)} contested kept")

    options = extract_options(sources, game_dir)
    print(f"\noptions: {len(options['rooms'])} rooms,"
          f" {len(options['advisor_voices'])} advisor voices,"
          f" {len(options['flag_categories'])} flag categories")

    print("\nicons...")
    sprites = build_sprites(sources)
    gfx = build_gfx_index(sources)
    print(f"  {len(sprites)} sprite definitions, {len(gfx)} texture files")
    wanted, missing = resolve_icons(entities, loc, loc_multi, sprites, gfx)
    print(f"  resolved {len(wanted)} icons")
    for cat, keys in sorted(missing.items()):
        print(f"  ! no icon for {len(keys)} {cat}: {', '.join(sorted(keys)[:6])}"
              + (" ..." if len(keys) > 6 else ""))
    icon_map, sheet_size = build_sprite_sheet(
        wanted, out_dir.parent / "icons" / "sprite.png")
    if icon_map:
        print(f"  sheet {sheet_size[0]}x{sheet_size[1]} with {len(icon_map)} cells")

    modifier_kinds = classify_modifiers(entities)
    pct = sum(1 for v in modifier_kinds.values() if v == "pct")
    print(f"\nmodifiers: {len(modifier_kinds)} distinct keys"
          f" ({pct} percentage, {len(modifier_kinds) - pct} flat)")

    meta = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "game_version": version,
        "modifier_kinds": modifier_kinds,
        "sources": [
            {k: v for k, v in src.items() if k != "root"} for src in sources
        ],
        "files": file_providers,
        "counts": {cat: len({e["id"] for e in entities[cat]}) for cat in entities},
    }

    print("\nwriting...")
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    total += write_json(out_dir / "meta.json", meta, "meta")
    total += write_json(out_dir / "defines.json", defines, "defines")
    total += write_json(out_dir / "options.json", options, "options")
    total += write_json(out_dir / "entities.json", entities, "entities")
    total += write_json(out_dir / "loc.json", {"single": loc, "multi": loc_multi}, "localisation")
    if icon_map:
        total += write_json(
            out_dir / "icons.json",
            {"sheet": "icons/sprite.png", "size": list(sheet_size), "cells": icon_map},
            "icon map",
        )
        png = out_dir.parent / "icons" / "sprite.png"
        total += png.stat().st_size
        print(f"  {'sprite sheet':<22} {png.stat().st_size/1024:8.1f} KB  {png.name}")
    print(f"\n  total {total/1024/1024:.2f} MB in {time.time()-started:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
