// Loading the extracted data, and re-merging it for whatever mods are enabled.
//
// The extractor deliberately does not ship a pre-merged dataset - it ships every
// definition tagged with its source, file and load-order ordinal. Merging here is
// what makes the mod toggles honest, because Paradox has two override rules and
// both matter for this playset:
//
//   1. A mod file at the same relative path replaces the base file wholesale.
//      Ethics and Civics Classic ships an empty 00_authorities.txt purely to
//      delete the vanilla authorities before re-declaring them elsewhere.
//   2. A definition of the same id from a *different* filename wins by load
//      order. The same mod redefines ethic_authoritarian from EaC_ethics.txt.
//
// A naive union of everything would be wrong in both directions.

const DATA_FILES = ['meta', 'entities', 'loc', 'defines', 'options', 'icons'];

export const CATEGORIES = [
  'ethics', 'ethic_categories', 'authorities', 'civics', 'origins', 'governments',
  'species_archetypes', 'species_classes', 'species_traits', 'leader_traits',
  'graphical_culture', 'planet_classes', 'portrait_sets', 'name_lists',
];

export async function loadDatabase(base = '') {
  const parts = await Promise.all(DATA_FILES.map(async (name) => {
    const res = await fetch(`${base}data/${name}.json`);
    if (!res.ok) throw new Error(`could not load data/${name}.json (${res.status})`);
    return [name, await res.json()];
  }));
  const db = Object.fromEntries(parts);
  db.order = Object.fromEntries(db.meta.sources.map((s) => [s.id, s.order]));
  return db;
}

/** Which mods actually change anything on this screen. */
export function contentSources(db) {
  const touched = new Set();
  for (const cat of CATEGORIES) {
    for (const ent of db.entities[cat] || []) touched.add(ent.src);
  }
  for (const def of db.defines) touched.add(def.src);
  return touched;
}

/**
 * Resolve the live entity set for a given set of enabled source ids.
 * Returns { cat: Map<id, entity>, defines, loc(key), source(id) }.
 */
export function buildView(db, enabled) {
  const winners = fileWinners(db, enabled);
  const cat = {};
  for (const name of CATEGORIES) {
    cat[name] = mergeCategory(db.entities[name] || [], winners);
  }

  const defines = {};
  for (const entry of db.defines) {
    if (enabled.has(entry.src)) Object.assign(defines, entry.values);
  }

  return {
    db,
    enabled,
    cat,
    defines,
    loc: (key) => lookupLoc(db, enabled, key),
    icon: (key) => db.icons.cells[key] || null,
  };
}

function fileWinners(db, enabled) {
  const winners = new Map();
  for (const [path, providers] of Object.entries(db.meta.files)) {
    let best = null;
    let bestOrder = -1;
    for (const src of providers) {
      if (!enabled.has(src)) continue;
      const order = db.order[src] ?? -1;
      if (order > bestOrder) { best = src; bestOrder = order; }
    }
    if (best !== null) winners.set(path, best);
  }
  return winners;
}

function mergeCategory(defs, winners) {
  const live = new Map();
  for (const ent of defs) {
    // Losing provider of a replaced file: this definition never loads at all.
    if (winners.get(ent.file) !== ent.src) continue;
    const current = live.get(ent.id);
    if (!current || ent.ord > current.ord) live.set(ent.id, ent);
  }
  return live;
}

function lookupLoc(db, enabled, key) {
  if (!key) return '';
  const contested = db.loc.multi[key];
  if (contested) {
    for (let i = contested.length - 1; i >= 0; i -= 1) {
      const [src, value] = contested[i];
      if (enabled.has(src)) return value;
    }
    return contested[0][1];
  }
  // A key defined exactly once belongs either to the base game or to the mod
  // that also owns the entity, so it cannot outlive a disabled toggle.
  return db.loc.single[key] ?? '';
}
