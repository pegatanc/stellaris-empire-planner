// Requirement verification and point budgets.
//
// common/governments/99_README_GOVERNMENT.txt documents that `potential` and
// `possible` on civics, origins and authorities are NOT general triggers - they
// use a closed list syntax over a fixed set of categories. That is what makes
// real validation possible here instead of decorative validation.
//
// The shipped data deviates from that spec in several places, all handled below.
// Anything still unrecognised is recorded in `unknown` and surfaced as an
// "unverified" badge - never silently treated as satisfied.

import { arr, num } from './util.js';

// Scripted-trigger shims for DLC ownership, from common/scripted_triggers/.
export const DLC_TRIGGERS = {
  has_utopia: 'Utopia',
  has_apocalypse_dlc: 'Apocalypse',
  has_megacorp: 'Megacorp',
  has_federations_dlc: 'Federations',
  has_nemesis: 'Nemesis',
  has_overlord_dlc: 'Overlord',
  has_leviathans: 'Leviathans Story Pack',
  has_distar: 'Distant Stars Story Pack',
  has_ancrel: 'Ancient Relics Story Pack',
  has_first_contact_dlc: 'First Contact Story Pack',
  has_paragon_dlc: 'Galactic Paragons',
  has_astral_planes_dlc: 'Astral Planes',
  has_machine_age_dlc: 'The Machine Age',
  has_cosmic_storms_dlc: 'Cosmic Storms',
  has_grand_archive_dlc: 'Grand Archive',
  has_biogenesis_dlc: 'BioGenesis',
  has_shroud_dlc: 'Shadows of the Shroud',
  has_nomads_dlc: 'Nomads',
  has_plantoids: 'Plantoids Species Pack',
  has_lithoids: 'Lithoids Species Pack',
  has_necroids: 'Necroids Species Pack',
  has_aquatics: 'Aquatics Species Pack',
  has_toxoids: 'Toxoids Species Pack',
  has_infernals: 'Infernals Species Pack',
  has_humanoids: 'Humanoids Species Pack',
  has_synthetic_dawn: 'Synthetic Dawn Story Pack',
  has_horizonsignal: 'Horizon Signal',
};

const NEGATED_DLC_TRIGGERS = {
  has_not_megacorp: 'Megacorp',
  has_not_machine_age_dlc: 'The Machine Age',
};

const setOf = (value) => new Set(value ? [value] : []);

// Category keys usable inside potential/possible, mapped onto build state.
// `origin`, `species_archetype` and `species_class` are undocumented but are
// used heavily - `origin` more often than `country_type`.
export const CATEGORY_SOURCES = {
  ethics: (ctx) => ctx.ethics,
  civics: (ctx) => ctx.civics,
  authority: (ctx) => setOf(ctx.authority),
  origin: (ctx) => setOf(ctx.origin),
  country_type: () => new Set(['default']),
  graphical_culture: (ctx) => setOf(ctx.shipset),
  ship_categories: (ctx) => setOf(ctx.shipset),
  traits: (ctx) => ctx.traits,
  species_archetype: (ctx) => setOf(ctx.archetype),
  species_class: (ctx) => setOf(ctx.speciesClass),
  preferred_planet_class: (ctx) => setOf(ctx.planetClass),
};

// Bare booleans that appear directly inside a requirement block.
const BARE_TRIGGERS = {
  is_nomadic: (value, ctx) => (value === 'yes') === Boolean(ctx.isNomadic),
  always: (value) => value === 'yes',
};

const IGNORED_KEYS = new Set(['text', '__list', 'limit']);

// --------------------------------------------------------------------------
// Category-level evaluation (inside `ethics = { ... }` and friends)
// --------------------------------------------------------------------------

function categoryNode(node, have, unknown, category, mode = 'AND') {
  if (!node || typeof node !== 'object') return true;
  const results = [];

  for (const [key, raw] of Object.entries(node)) {
    if (IGNORED_KEYS.has(key)) continue;
    // Government Variety Pack ships lowercase `nor` / `not`.
    const op = key.toUpperCase();

    if (key === 'value') {
      for (const value of arr(raw)) results.push(have.has(value));
    } else if (op === 'OR') {
      for (const sub of arr(raw)) results.push(categoryNode(sub, have, unknown, category, 'OR'));
    } else if (op === 'AND') {
      for (const sub of arr(raw)) results.push(categoryNode(sub, have, unknown, category, 'AND'));
    } else if (op === 'NOT' || op === 'NOR') {
      // The spec says NOT may hold only one value, but four vanilla entries put
      // several in one. The engine treats those as NOR, so we do too.
      for (const sub of arr(raw)) results.push(!categoryNode(sub, have, unknown, category, 'OR'));
    } else {
      unknown.add(`${category}.${key}`);
    }
  }

  // An empty block: AND over nothing is satisfied, OR over nothing is not.
  // This matters through negation - Ethics and Civics Classic ships
  // `civics = { NOT = {} }` on civic_feudal_realm, and reading the empty OR as
  // true made the NOT false and the civic permanently unpickable.
  if (!results.length) return mode !== 'OR';
  return mode === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

// --------------------------------------------------------------------------
// Requirement-level evaluation (the body of potential / possible)
// --------------------------------------------------------------------------

export function evalRequirement(node, ctx, unknown, mode = 'AND') {
  if (!node || typeof node !== 'object') return true;
  const results = [];

  for (const [key, raw] of Object.entries(node)) {
    if (IGNORED_KEYS.has(key)) continue;
    const op = key.toUpperCase();

    if (CATEGORY_SOURCES[key]) {
      const have = CATEGORY_SOURCES[key](ctx);
      for (const sub of arr(raw)) results.push(categoryNode(sub, have, unknown, key));
    } else if (op === 'OR') {
      for (const sub of arr(raw)) results.push(evalRequirement(sub, ctx, unknown, 'OR'));
    } else if (op === 'AND') {
      for (const sub of arr(raw)) {
        // `AND = { limit = { <trigger> } ... }` short-circuits to true when the
        // guard is false (common/species_classes/00_species_classes.txt).
        if (sub && sub.limit && !evalTrigger(sub.limit, ctx, unknown)) {
          results.push(true);
          continue;
        }
        results.push(evalRequirement(sub, ctx, unknown, 'AND'));
      }
    } else if (op === 'NOT' || op === 'NOR') {
      for (const sub of arr(raw)) results.push(!evalRequirement(sub, ctx, unknown, 'OR'));
    } else if (BARE_TRIGGERS[key]) {
      for (const value of arr(raw)) results.push(BARE_TRIGGERS[key](value, ctx));
    } else {
      unknown.add(key);
    }
  }

  // An empty block: AND over nothing is satisfied, OR over nothing is not.
  // This matters through negation - Ethics and Civics Classic ships
  // `civics = { NOT = {} }` on civic_feudal_realm, and reading the empty OR as
  // true made the NOT false and the civic permanently unpickable.
  if (!results.length) return mode !== 'OR';
  return mode === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

// --------------------------------------------------------------------------
// Ordinary triggers (playable / ai_playable are NOT list syntax)
// --------------------------------------------------------------------------

export function evalTrigger(node, ctx, unknown, mode = 'AND') {
  if (!node || typeof node !== 'object') return true;
  const results = [];

  for (const [key, raw] of Object.entries(node)) {
    if (key === '__list') continue;
    const op = key.toUpperCase();

    for (const value of arr(raw)) {
      let result;
      if (op === 'OR') result = evalTrigger(value, ctx, unknown, 'OR');
      else if (op === 'AND') result = evalTrigger(value, ctx, unknown, 'AND');
      else if (op === 'NOT' || op === 'NOR') result = !evalTrigger(value, ctx, unknown, 'OR');
      else if (key === 'always') result = value === 'yes';
      else if (key === 'host_has_dlc' || key === 'has_dlc' || key === 'owner_has_dlc') {
        result = ctx.dlcs.has(String(value));
      } else if (DLC_TRIGGERS[key]) {
        result = ctx.dlcs.has(DLC_TRIGGERS[key]) === (value !== 'no');
      } else if (NEGATED_DLC_TRIGGERS[key]) {
        result = !ctx.dlcs.has(NEGATED_DLC_TRIGGERS[key]) === (value !== 'no');
      } else if (key === 'has_global_flag') {
        // Nothing is flagged during empire creation; this is how the ROBOT
        // species class keeps itself out of the designer.
        result = false;
      } else {
        unknown.add(key);
        result = true;
      }
      results.push(result);
    }
  }

  // An empty block: AND over nothing is satisfied, OR over nothing is not.
  // This matters through negation - Ethics and Civics Classic ships
  // `civics = { NOT = {} }` on civic_feudal_realm, and reading the empty OR as
  // true made the NOT false and the civic permanently unpickable.
  if (!results.length) return mode !== 'OR';
  return mode === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

// --------------------------------------------------------------------------
// Entity verdicts
// --------------------------------------------------------------------------

/**
 * @returns {{available: boolean, ok: boolean, reasons: object[], unknown: string[]}}
 *   available - passes `playable` and `potential`; otherwise it is not offered at all
 *   ok        - passes `possible`; otherwise it is offered but blocked
 */
export function evaluate(entity, ctx) {
  const data = entity.data || {};
  const unknown = new Set();

  const playable = data.playable ? evalTrigger(data.playable, ctx, unknown) : true;
  const potential = data.potential ? evalRequirement(data.potential, ctx, unknown) : true;
  const ok = data.possible ? evalRequirement(data.possible, ctx, unknown) : true;

  const reasons = ok ? [] : failingClauses(data.possible, ctx);
  return {
    available: playable && potential,
    ok,
    reasons,
    unknown: [...unknown],
  };
}

/**
 * The requirement top level is an implicit AND, so each clause can be evaluated
 * on its own to find exactly which ones block the pick.
 */
function failingClauses(block, ctx) {
  const out = [];
  // A `text` beside the clauses is the block's own explanation; use it wherever
  // a clause has none of its own.
  const blockText = block && typeof block === 'object' ? block.text : null;
  for (const [key, raw] of Object.entries(block || {})) {
    if (IGNORED_KEYS.has(key)) continue;
    for (const sub of arr(raw)) {
      const scratch = new Set();
      if (evalRequirement({ [key]: sub }, ctx, scratch)) continue;
      for (const reason of describeClause(key, sub, ctx)) {
        if (!reason.text && blockText) reason.text = blockText;
        out.push(reason);
      }
    }
  }
  return out;
}

/**
 * One reason per failing sub-clause, each carrying its own `text` override.
 * Merging them would attach the wrong tooltip to the wrong values - a NOR's
 * "not xenophobe" text next to a required-value list, for instance.
 */
function describeClause(key, node, ctx) {
  const op = key.toUpperCase();

  // A failing OR/AND at the requirement level is a set of alternatives, not one
  // condition. Each branch is described on its own so the message can read
  // "Requires X, or Y, or Z" instead of "Blocked by OR".
  if ((op === 'OR' || op === 'AND') && node && typeof node === 'object') {
    const branches = [];
    for (const [childKey, raw] of Object.entries(node)) {
      if (IGNORED_KEYS.has(childKey)) continue;
      for (const sub of arr(raw)) {
        const group = describeClause(childKey, sub, ctx);
        if (group.length) branches.push(group);
      }
    }
    if (branches.length) {
      return [{
        category: key,
        text: node.text || null,
        need: [],
        forbid: [],
        mode: op === 'OR' ? 'any' : 'all',
        branches,
      }];
    }
  }

  if (op === 'NOT' || op === 'NOR') {
    // A negated requirement block fails because its contents are TRUE, so there
    // are no inner failures to describe - report the values you hold that rule
    // the pick out.
    const out = [];
    for (const [childKey, raw] of Object.entries(node || {})) {
      if (IGNORED_KEYS.has(childKey) || !CATEGORY_SOURCES[childKey]) continue;
      const have = CATEGORY_SOURCES[childKey](ctx);
      for (const sub of arr(raw)) {
        const present = valuesIn(sub).filter((value) => have.has(value));
        if (present.length) {
          out.push({
            category: childKey,
            text: node?.text || sub?.text || null,
            need: [],
            forbid: present,
            mode: 'none',
          });
        }
      }
    }
    if (out.length) return out;
  }

  if (CATEGORY_SOURCES[key]) {
    const have = CATEGORY_SOURCES[key](ctx);
    const out = [];
    collectCategoryFailures(node, have, key, out, node?.text || null);
    if (!out.length) out.push({ category: key, text: node?.text || null, need: [], forbid: [], mode: 'all' });
    return out;
  }
  if (key === 'always') {
    // `always = no` is how a mod ships an entry switched off (Gigastructural's
    // Frameworld origin, "Disabled for 4.0"). It is not a requirement you can
    // meet, so say that rather than rendering it as one.
    return [{ category: 'disabled', text: null, need: [], forbid: [], mode: 'all' }];
  }
  if (BARE_TRIGGERS[key]) {
    return [{
      category: key,
      text: null,
      need: [`${key} = ${node}`],
      forbid: [],
      mode: 'all',
      literal: true,
    }];
  }
  const reason = { category: key, text: null, need: [], forbid: [], mode: 'all' };
  collectNestedText(node, reason);
  return [reason];
}

function collectCategoryFailures(node, have, category, out, inheritedText) {
  if (!node || typeof node !== 'object') return;
  for (const [key, raw] of Object.entries(node)) {
    if (IGNORED_KEYS.has(key)) continue;
    const op = key.toUpperCase();

    if (key === 'value') {
      // A bare value list is an AND: every one of them must be present.
      const missing = arr(raw).filter((value) => !have.has(value));
      if (missing.length) {
        out.push({ category, text: inheritedText, need: missing, forbid: [], mode: 'all' });
      }
    } else if (op === 'NOT' || op === 'NOR') {
      for (const sub of arr(raw)) {
        const present = valuesIn(sub).filter((value) => have.has(value));
        if (present.length) {
          out.push({ category, text: sub?.text || inheritedText, need: [], forbid: present, mode: 'none' });
        }
      }
    } else if (op === 'OR') {
      for (const sub of arr(raw)) {
        const options = valuesIn(sub);
        if (options.length && !options.some((value) => have.has(value))) {
          out.push({ category, text: sub?.text || inheritedText, need: options, forbid: [], mode: 'any' });
        }
      }
    } else if (op === 'AND') {
      for (const sub of arr(raw)) {
        collectCategoryFailures(sub, have, category, out, sub?.text || inheritedText);
      }
    }
  }
}

function valuesIn(node) {
  if (!node || typeof node !== 'object') return [];
  let out = arr(node.value);
  for (const [key, raw] of Object.entries(node)) {
    if (key === 'value' || IGNORED_KEYS.has(key)) continue;
    for (const sub of arr(raw)) out = out.concat(valuesIn(sub));
  }
  return out;
}

function collectNestedText(node, reason) {
  if (!node || typeof node !== 'object') return;
  if (node.text && !reason.text) reason.text = node.text;
  for (const raw of Object.values(node)) {
    for (const sub of arr(raw)) collectNestedText(sub, reason);
  }
}

// --------------------------------------------------------------------------
// Government names
//
// Government `possible` blocks use ordinary country-scope triggers rather than
// the list syntax, but the vocabulary is small and enumerable. Triggers that
// only become true after the game starts - ascension authority swaps, country
// flags, AI/primitive checks - are false at empire creation, which is exactly
// what keeps post-ascension government names out of the designer.
// --------------------------------------------------------------------------

const ETHIC_AXIS = {
  is_authoritarian: ['ethic_authoritarian', 'ethic_fanatic_authoritarian'],
  is_egalitarian: ['ethic_egalitarian', 'ethic_fanatic_egalitarian'],
  is_xenophobe: ['ethic_xenophobe', 'ethic_fanatic_xenophobe'],
  is_xenophile: ['ethic_xenophile', 'ethic_fanatic_xenophile'],
  is_militarist: ['ethic_militarist', 'ethic_fanatic_militarist'],
  is_pacifist: ['ethic_pacifist', 'ethic_fanatic_pacifist'],
  is_spiritualist: ['ethic_spiritualist', 'ethic_fanatic_spiritualist'],
  is_materialist: ['ethic_materialist', 'ethic_fanatic_materialist'],
  is_gestalt: ['ethic_gestalt_consciousness'],
  // Ethics and Civics Classic axes.
  is_socialism: ['ethic_socialism', 'ethic_fanatic_socialism'],
  is_capitalism: ['ethic_capitalism', 'ethic_fanatic_capitalism'],
  is_green: ['ethic_green', 'ethic_fanatic_green'],
  is_industrial: ['ethic_industrial', 'ethic_fanatic_industrial'],
};

const AUTHORITY_GROUP = {
  is_democratic_authority: ['auth_democratic', 'auth_direct_democratic'],
  is_democratic: ['auth_democratic', 'auth_direct_democratic'],
  has_auth_democratic: ['auth_democratic', 'auth_direct_democratic'],
  is_oligarchic_authority: ['auth_oligarchic'],
  has_auth_oligarchic: ['auth_oligarchic'],
  is_dictatorial_authority: ['auth_dictatorial'],
  has_auth_dictatorial: ['auth_dictatorial'],
  is_imperial_authority: ['auth_imperial'],
  has_auth_imperial: ['auth_imperial'],
  is_megacorp: ['auth_corporate'],
  is_corporate: ['auth_corporate'],
  has_auth_corporate: ['auth_corporate'],
  is_hive_empire: ['auth_hive_mind'],
  has_auth_hive: ['auth_hive_mind'],
  is_machine_empire: ['auth_machine_intelligence', 'auth_ancient_machine_intelligence'],
  has_auth_machine: ['auth_machine_intelligence'],
};

// True only once a game is running, so false in the designer.
const RUNTIME_ONLY = new Set([
  'is_ai', 'is_primitive', 'has_country_flag', 'has_global_flag',
  'is_mutation_authority', 'is_purity_authority', 'is_cloning_authority',
  'is_transcendent_authority', 'is_corporeal_authority',
  'is_cyber_creed_advanced_government', 'is_cyber_creed_government',
  'has_ascension_perk', 'has_technology', 'is_subject', 'has_relic',
]);

export function evalGovernmentTrigger(node, ctx, unknown, mode = 'AND') {
  if (!node || typeof node !== 'object') return true;
  const results = [];

  for (const [key, raw] of Object.entries(node)) {
    if (key === '__list') continue;
    const op = key.toUpperCase();

    for (const value of arr(raw)) {
      const wants = value !== 'no';
      let result;

      if (op === 'OR') result = evalGovernmentTrigger(value, ctx, unknown, 'OR');
      else if (op === 'AND') result = evalGovernmentTrigger(value, ctx, unknown, 'AND');
      else if (op === 'NOT' || op === 'NOR') result = !evalGovernmentTrigger(value, ctx, unknown, 'OR');
      else if (key === 'always') result = value === 'yes';
      else if (key === 'is_nomadic') result = Boolean(ctx.isNomadic) === wants;
      else if (key === 'has_valid_civic' || key === 'has_civic') result = ctx.civics.has(value);
      else if (key === 'has_ethic') result = ctx.ethics.has(value);
      else if (key === 'has_origin') result = ctx.origin === value;
      else if (key === 'has_authority') result = ctx.authority === value;
      else if (ETHIC_AXIS[key]) {
        result = ETHIC_AXIS[key].some((id) => ctx.ethics.has(id)) === wants;
      } else if (AUTHORITY_GROUP[key]) {
        result = AUTHORITY_GROUP[key].includes(ctx.authority) === wants;
      } else if (key === 'is_wilderness_empire') {
        result = (ctx.origin === 'origin_wilderness') === wants;
      } else if (key === 'is_worker_coop_empire') {
        result = ctx.civics.has('civic_worker_coop') === wants;
      } else if (key === 'host_has_dlc' || key === 'has_dlc') {
        result = ctx.dlcs.has(String(value));
      } else if (DLC_TRIGGERS[key]) {
        result = ctx.dlcs.has(DLC_TRIGGERS[key]) === wants;
      } else if (RUNTIME_ONLY.has(key)) {
        result = !wants;      // the trigger is false, so `= no` passes
      } else {
        unknown.add(key);
        // Governments are a ranked list; assuming an unknown trigger true would
        // flood it with post-ascension names, so stay conservative here.
        result = false;
      }
      results.push(result);
    }
  }

  // An empty block: AND over nothing is satisfied, OR over nothing is not.
  // This matters through negation - Ethics and Civics Classic ships
  // `civics = { NOT = {} }` on civic_feudal_realm, and reading the empty OR as
  // true made the NOT false and the civic permanently unpickable.
  if (!results.length) return mode !== 'OR';
  return mode === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

/** Governments whose requirements the current build satisfies, best first. */
export function matchingGovernments(view, ctx) {
  const out = [];
  for (const [id, entity] of view.cat.governments) {
    const unknown = new Set();
    if (!evalGovernmentTrigger(entity.data.possible, ctx, unknown)) continue;
    out.push({
      id,
      entity,
      weight: num(entity.data.weight?.base, 1),
      unknown: [...unknown],
    });
  }
  out.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  return out;
}

// --------------------------------------------------------------------------
// Species traits
// --------------------------------------------------------------------------

const GATE_LISTS = [
  ['allowed_origins', 'origin', true],
  ['forbidden_origins', 'origin', false],
  ['allowed_civics', 'civics', true],
  ['forbidden_civics', 'civics', false],
  ['allowed_ethics', 'ethics', true],
  ['forbidden_ethics', 'ethics', false],
];

/**
 * Traits the build gets for free from its origin, civics, authority or species
 * class. `traits` are locked in; origin `soft_traits` can be removed again.
 */
export function forcedTraits(view, build) {
  const locked = new Map();
  const soft = new Map();

  const take = (entity, label) => {
    if (!entity) return;
    // Origins, civics and authorities use `traits = { trait = x }`; species
    // classes use a bare top-level `trait = x` for their marker trait
    // (trait_organic, trait_lithoid, trait_machine_unit). Both must be caught,
    // or an exported species would be missing the trait the game requires.
    for (const id of arr(entity.data.traits?.trait)) locked.set(id, label);
    for (const id of arr(entity.data.trait)) locked.set(id, label);
    for (const id of arr(entity.data.soft_traits?.trait)) soft.set(id, label);
  };

  take(view.cat.species_classes.get(build.speciesClass), 'species class');
  take(view.cat.authorities.get(build.authority), 'authority');
  take(view.cat.origins.get(build.origin), 'origin');
  for (const id of build.civics) take(view.cat.civics.get(id), 'civic');

  return { locked, soft };
}

export function traitCost(entity) {
  const cost = entity.data.cost;
  if (cost && typeof cost === 'object') return num(cost.base, 0);
  return num(cost, 0);
}

/** Traits the designer never offers: forced markers, presapient, hidden. */
export function traitIsSelectable(entity) {
  const data = entity.data;
  if (data.hidden === 'yes') return false;
  const potential = data.species_potential_add;
  if (potential && typeof potential === 'object' && potential.always === 'no') return false;
  return true;
}

export function traitStatus(entity, ctx) {
  const data = entity.data;
  const unknown = new Set();
  const reasons = [];

  const archetypes = arr(data.allowed_archetypes?.__list);
  if (archetypes.length && !archetypes.includes(ctx.archetype)) {
    return { available: false, ok: false, reasons: [], unknown: [] };
  }

  if (data.species_class) {
    const classes = arr(data.species_class.__list);
    if (classes.length) {
      if (!classes.includes(ctx.speciesClass)) {
        return { available: false, ok: false, reasons: [], unknown: [] };
      }
    } else if (!categoryNode(data.species_class, setOf(ctx.speciesClass), unknown, 'species_class')) {
      return { available: false, ok: false, reasons: [], unknown: [...unknown] };
    }
  }

  if (data.host_has_dlc && !ctx.dlcs.has(String(data.host_has_dlc))) {
    return { available: false, ok: false, reasons: [], unknown: [] };
  }

  for (const [field, category, mustInclude] of GATE_LISTS) {
    const list = arr(data[field]?.__list);
    if (!list.length) continue;
    const have = CATEGORY_SOURCES[category](ctx);
    const hit = list.some((value) => have.has(value));
    if (mustInclude && !hit) {
      reasons.push({ category, text: null, need: list, forbid: [] });
    } else if (!mustInclude && hit) {
      reasons.push({ category, text: null, need: [], forbid: list.filter((v) => have.has(v)) });
    }
  }

  const opposites = arr(data.opposites?.__list).filter((id) => ctx.traits.has(id));
  if (opposites.length) {
    reasons.push({ category: 'traits', text: null, need: [], forbid: opposites });
  }

  return { available: true, ok: reasons.length === 0, reasons, unknown: [...unknown] };
}

// --------------------------------------------------------------------------
// Budgets
// --------------------------------------------------------------------------

const MODIFIER_FIELDS = ['modifier', 'country_modifier'];
const TRIGGERED_FIELDS = ['triggered_country_modifier', 'triggered_modifier'];
const NOT_A_MODIFIER = new Set(['__list', 'custom_tooltip', 'potential', 'desc', 'text']);

function flatten(block) {
  const out = [];
  if (!block || typeof block !== 'object') return out;
  for (const [key, raw] of Object.entries(block)) {
    if (NOT_A_MODIFIER.has(key)) continue;
    const value = num(raw, NaN);
    if (Number.isFinite(value)) out.push({ key, value });
  }
  return out;
}

/**
 * What one entity actually does, split by whether its condition holds.
 * `state` is 'met', 'unmet', or 'unknown' when the gate needs in-game state.
 */
export function entityModifiers(entity, ctx) {
  const active = [];
  const conditional = [];
  const tooltips = [];

  for (const field of MODIFIER_FIELDS) {
    const block = entity.data[field];
    active.push(...flatten(block));
    if (block && typeof block === 'object' && typeof block.custom_tooltip === 'string') {
      tooltips.push(block.custom_tooltip);
    }
  }
  if (typeof entity.data.custom_tooltip_with_modifiers === 'string') {
    tooltips.push(entity.data.custom_tooltip_with_modifiers);
  }

  for (const field of TRIGGERED_FIELDS) {
    for (const block of arr(entity.data[field])) {
      if (!block || typeof block !== 'object') continue;
      const unknown = new Set();
      const passes = block.potential
        ? evalGovernmentTrigger(block.potential, ctx, unknown)
        : true;
      const state = unknown.size ? 'unknown' : (passes ? 'met' : 'unmet');
      for (const item of flatten(block)) {
        if (state === 'met') active.push(item);
        else conditional.push({ ...item, state, potential: block.potential });
      }
    }
  }

  return { active, conditional, tooltips };
}

/** Every modifier the current picks contribute, with attribution. */
export function aggregateModifiers(view, build) {
  const totals = new Map();
  const contributions = [];
  const ctx = makeContext(view, build);

  const visit = (category, id, kind) => {
    const entity = view.cat[category]?.get(id);
    if (!entity) return;
    for (const { key, value } of entityModifiers(entity, ctx).active) {
      totals.set(key, (totals.get(key) || 0) + value);
      contributions.push({ key, value, fromId: id, fromKind: kind });
    }
  };

  for (const id of build.ethics) visit('ethics', id, 'ethic');
  visit('authorities', build.authority, 'authority');
  visit('origins', build.origin, 'origin');
  for (const id of build.civics) visit('civics', id, 'civic');
  for (const id of build.traits) visit('species_traits', id, 'trait');
  for (const id of build.rulerTraits) visit('leader_traits', id, 'ruler trait');

  return { totals, contributions };
}

export function archetypeOf(view, speciesClassId) {
  const cls = view.cat.species_classes.get(speciesClassId);
  return cls?.data.archetype || 'BIOLOGICAL';
}

function archetypeTraitBudget(view, archetype) {
  let current = view.cat.species_archetypes.get(archetype);
  let guard = 0;
  // LITHOID declares inherit_trait_points_from = BIOLOGICAL rather than its own.
  while (current && current.data.species_trait_points === undefined
         && current.data.inherit_trait_points_from && guard < 4) {
    current = view.cat.species_archetypes.get(current.data.inherit_trait_points_from);
    guard += 1;
  }
  return {
    points: num(current?.data.species_trait_points, 2),
    picks: num(current?.data.species_max_traits, 5),
  };
}

export function computeBudgets(view, build, modifierTotals) {
  const bonus = (key) => modifierTotals.get(key) || 0;

  let ethicsUsed = 0;
  for (const id of build.ethics) {
    ethicsUsed += num(view.cat.ethics.get(id)?.data.cost, 0);
  }

  const archetype = archetypeOf(view, build.speciesClass);
  const base = archetypeTraitBudget(view, archetype);

  let traitPointsUsed = 0;
  for (const id of build.traits) {
    const trait = view.cat.species_traits.get(id);
    if (trait) traitPointsUsed += traitCost(trait);
  }

  return {
    ethics: {
      used: ethicsUsed,
      max: num(view.defines.ETHOS_MAX_POINTS, 3),
    },
    civics: {
      used: build.civics.size,
      max: num(view.defines.GOVERNMENT_CIVIC_POINTS_BASE, 2)
           + bonus('country_government_civic_points_add'),
    },
    traitPoints: {
      used: traitPointsUsed,
      max: base.points + bonus(`${archetype}_species_trait_points_add`),
    },
    traitPicks: {
      used: build.traits.size,
      max: base.picks + bonus(`${archetype}_species_trait_picks_add`),
    },
  };
}

/** Build state -> the shape the evaluators expect. */
export function makeContext(view, build) {
  return {
    ethics: build.ethics,
    civics: build.civics,
    traits: build.traits,
    authority: build.authority,
    origin: build.origin,
    shipset: build.shipset,
    speciesClass: build.speciesClass,
    archetype: archetypeOf(view, build.speciesClass),
    planetClass: build.planetClass,
    isNomadic: build.isNomadic,
    dlcs: build.dlcs,
  };
}
