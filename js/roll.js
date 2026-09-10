// Rolling a random empire using the game's own odds.
//
// Stellaris stores `random_weight` on civics, origins, ethics and authorities.
// Rolling against those numbers gives empires that feel like the game's own
// random ones rather than uniform noise - and a weight of 0 means "never pick
// this randomly", which is how 34 civics and 47 origins opt out.
//
// Every pick re-derives the context before the next one, so the result is legal
// by construction rather than legal by luck.

import { arr, num } from './util.js';
import * as rules from './rules.js';

const DEFAULT_WEIGHT = 1;      // documented default when random_weight is absent
const MAX_ATTEMPTS = 80;

function weightOf(entity) {
  const raw = entity.data.random_weight;
  if (raw === undefined) return DEFAULT_WEIGHT;
  const value = num(raw, DEFAULT_WEIGHT);
  return Number.isFinite(value) ? value : DEFAULT_WEIGHT;
}

function pickWeighted(candidates, rng) {
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  if (!candidates.length || total <= 0) return null;
  let roll = rng() * total;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate;
  }
  return candidates[candidates.length - 1];
}

/** `randomized = no` (or a block resolving to always = no) opts an entry out. */
function isRandomizable(entity) {
  const flag = entity.data.randomized;
  if (flag === 'no') return false;
  if (flag && typeof flag === 'object' && flag.always === 'no') return false;
  return weightOf(entity) > 0;
}

function candidatesFrom(map, ctx, extraFilter) {
  const out = [];
  for (const [id, entity] of map) {
    if (!isRandomizable(entity)) continue;
    const verdict = rules.evaluate(entity, ctx);
    if (!verdict.available || !verdict.ok) continue;
    if (extraFilter && !extraFilter(id, entity)) continue;
    out.push({ id, entity, weight: weightOf(entity) });
  }
  return out;
}

export const FLAVOURS = {
  any: { label: 'Anything' },
  gestalt: { label: 'Gestalt', ethic: 'ethic_gestalt_consciousness' },
  megacorp: { label: 'Megacorp', authority: 'auth_corporate' },
  machine: { label: 'Machine', speciesClass: 'MACHINE', ethic: 'ethic_gestalt_consciousness' },
};

/**
 * Produce a legal set of picks. Returns null if the constraint cannot be met
 * with the enabled mods, rather than handing back something invalid.
 */
export function rollEmpire(view, template, options = {}) {
  const { flavour = 'any', rng = Math.random } = options;
  const constraint = FLAVOURS[flavour] || FLAVOURS.any;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const build = attemptRoll(view, template, constraint, rng);
    if (build) return build;
  }
  return null;
}

function attemptRoll(view, template, constraint, rng) {
  const build = {
    ...template,
    ethics: new Set(),
    civics: new Set(),
    traits: new Set(),
    rulerTraits: new Set(),
    authority: '',
    origin: 'origin_default',
  };
  const ctx = () => rules.makeContext(view, build);

  // 1. Species class. Machine flavour forces it; otherwise roll among classes
  //    that declare an archetype and are offered at creation.
  if (constraint.speciesClass && view.cat.species_classes.has(constraint.speciesClass)) {
    build.speciesClass = constraint.speciesClass;
  } else {
    const classes = candidatesFrom(view.cat.species_classes, ctx(), (_id, e) => e.data.archetype);
    const picked = pickWeighted(classes, rng);
    if (!picked) return null;
    build.speciesClass = picked.id;
  }
  const speciesEntity = view.cat.species_classes.get(build.speciesClass);
  if (speciesEntity?.data.graphical_culture) build.shipset = speciesEntity.data.graphical_culture;

  // 2. Ethics, drawn until nothing affordable is left. One per axis, and
  //    gestalt excludes everything else.
  if (constraint.ethic && view.cat.ethics.has(constraint.ethic)) {
    build.ethics.add(constraint.ethic);
  }
  const gestalt = 'ethic_gestalt_consciousness';
  for (let guard = 0; guard < 12; guard += 1) {
    const budget = rules.computeBudgets(view, build, new Map());
    const left = budget.ethics.max - budget.ethics.used;
    if (left <= 0) break;
    if (build.ethics.has(gestalt)) break;

    const usedAxes = new Set(
      [...build.ethics].map((id) => view.cat.ethics.get(id)?.data.category),
    );
    const options = [];
    for (const [id, entity] of view.cat.ethics) {
      if (build.ethics.has(id) || !isRandomizable(entity)) continue;
      if (id === gestalt && build.ethics.size) continue;
      if (build.ethics.size && usedAxes.has(entity.data.category)) continue;
      if (num(entity.data.cost, 1) > left) continue;
      options.push({ id, entity, weight: weightOf(entity) });
    }
    const picked = pickWeighted(options, rng);
    if (!picked) break;
    build.ethics.add(picked.id);
    if (picked.id === gestalt) break;
  }
  if (!build.ethics.size) return null;

  // 3. Authority.
  const authorities = candidatesFrom(view.cat.authorities, ctx(),
    (id) => !constraint.authority || id === constraint.authority);
  const authority = pickWeighted(authorities, rng);
  if (!authority) return null;      // constraint impossible with these ethics
  build.authority = authority.id;

  // 4. Origin.
  const origin = pickWeighted(candidatesFrom(view.cat.origins, ctx()), rng);
  if (origin) build.origin = origin.id;

  // 5. Civics, one at a time so mutually exclusive ones cannot both land.
  for (let guard = 0; guard < 12; guard += 1) {
    const budget = rules.computeBudgets(view, build, rules.aggregateModifiers(view, build).totals);
    if (build.civics.size >= budget.civics.max) break;
    const picked = pickWeighted(
      candidatesFrom(view.cat.civics, ctx(), (id) => !build.civics.has(id)), rng,
    );
    if (!picked) break;
    build.civics.add(picked.id);
  }

  // 6. Species traits, within both the point and the pick budget. Negative-cost
  //    traits buy points back, which is what the game does - but only reach for
  //    one once the points are gone, or the roll fills its picks with drawbacks
  //    and leaves the budget unspent.
  for (let guard = 0; guard < 16; guard += 1) {
    const totals = rules.aggregateModifiers(view, build).totals;
    const budget = rules.computeBudgets(view, build, totals);
    if (build.traits.size >= budget.traitPicks.max) break;
    const pointsLeft = budget.traitPoints.max - budget.traitPoints.used;

    const current = ctx();
    const options = [];
    for (const [id, entity] of view.cat.species_traits) {
      if (build.traits.has(id)) continue;
      if (!rules.traitIsSelectable(entity) || !isRandomizable(entity)) continue;
      const status = rules.traitStatus(entity, current);
      if (!status.available || !status.ok) continue;
      const cost = rules.traitCost(entity);
      if (cost > pointsLeft) continue;
      options.push({ id, entity, cost, weight: weightOf(entity) });
    }

    // Spend the budget before borrowing against it. A drawback is only worth
    // taking while there is still a pick left to spend the freed points on,
    // otherwise the roll ends under budget with a species full of penalties.
    const picksLeft = budget.traitPicks.max - build.traits.size;
    const positives = options.filter((o) => o.cost > 0);
    const pool = positives.length ? positives
      : (picksLeft >= 2 ? options.filter((o) => o.cost <= 0) : []);
    const picked = pickWeighted(pool, rng);
    if (!picked) break;
    build.traits.add(picked.id);
  }

  // 7. One starting ruler trait.
  const current = ctx();
  const rulerOptions = [];
  for (const [id, entity] of view.cat.leader_traits) {
    if (entity.data.starting_ruler_trait !== 'yes') continue;
    const forbidden = arr(entity.data.forbidden_origins?.__list);
    const allowed = arr(entity.data.allowed_origins?.__list);
    if (forbidden.includes(build.origin)) continue;
    if (allowed.length && !allowed.includes(build.origin)) continue;
    rulerOptions.push({ id, entity, weight: weightOf(entity) });
  }
  const rulerTrait = pickWeighted(rulerOptions, rng);
  if (rulerTrait) build.rulerTraits.add(rulerTrait.id);

  // 8. Homeworld: the origin wins if it dictates one.
  const originEntity = view.cat.origins.get(build.origin);
  const forced = originEntity?.data.starting_colony || originEntity?.data.habitability_preference;
  if (typeof forced === 'string') {
    build.planetClass = forced;
  } else {
    const planets = [];
    for (const [id, entity] of view.cat.planet_classes) {
      if (entity.data.climate && entity.data.colonizable === 'yes') {
        planets.push({ id, entity, weight: 1 });
      }
    }
    const planet = pickWeighted(planets, rng);
    if (planet) build.planetClass = planet.id;
  }

  return validate(view, build) ? build : null;
}

/** Re-check the finished roll the same way the screen would. */
function validate(view, build) {
  const ctx = rules.makeContext(view, build);
  const check = (category, id) => {
    if (!id) return true;
    const entity = view.cat[category]?.get(id);
    if (!entity) return false;
    const verdict = rules.evaluate(entity, ctx);
    return verdict.available && verdict.ok;
  };

  if (!check('authorities', build.authority)) return false;
  if (!check('origins', build.origin)) return false;
  for (const id of build.civics) if (!check('civics', id)) return false;
  for (const id of build.traits) {
    const entity = view.cat.species_traits.get(id);
    if (!entity || !rules.traitStatus(entity, ctx).ok) return false;
  }

  const totals = rules.aggregateModifiers(view, build).totals;
  const budget = rules.computeBudgets(view, build, totals);
  return budget.ethics.used <= budget.ethics.max
    && budget.civics.used <= budget.civics.max
    && budget.traitPoints.used <= budget.traitPoints.max
    && budget.traitPicks.used <= budget.traitPicks.max;
}
