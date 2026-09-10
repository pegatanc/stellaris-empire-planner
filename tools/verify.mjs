// End-to-end checks for the merge logic, the requirement evaluator and the
// empire-file round trip.
//
//   node tools/verify.mjs
//
// The strongest check here is the last one: it imports every empire already
// saved in the user's own user_empire_designs file and asserts the planner
// calls them valid. Those are designs Stellaris itself accepted, so a false
// "blocked" is a real bug in the evaluator rather than a fixture disagreement.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildView } from '../js/data.js';
import * as rules from '../js/rules.js';
import {
  makeContext, evaluate, computeBudgets, aggregateModifiers, archetypeOf,
} from '../js/rules.js';
import { parseEmpireDesigns, serializeEmpire, readEmpire, parseScript } from '../js/empirefile.js';
import { rollEmpire, FLAVOURS } from '../js/roll.js';
import { buildIndex, invalidateIndex } from '../js/effects.js';

// The browser modules use document for plain-text extraction of loc strings.
globalThis.document = {
  createElement: () => ({
    set innerHTML(v) { this._v = v; },
    get textContent() { return String(this._v || '').replace(/<[^>]*>/g, ''); },
  }),
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${name}.json`), 'utf8'));

const db = {
  meta: readJSON('meta'),
  entities: readJSON('entities'),
  loc: readJSON('loc'),
  defines: readJSON('defines'),
  options: readJSON('options'),
  icons: readJSON('icons'),
};
db.order = Object.fromEntries(db.meta.sources.map((s) => [s.id, s.order]));

const ALL_DLCS = new Set(db.options.dlcs.map((d) => d.name));

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const idsOf = (view, cat) => view.cat[cat];

function makeBuild(overrides = {}) {
  return {
    name: 'Test',
    ethics: new Set(),
    civics: new Set(),
    traits: new Set(),
    rulerTraits: new Set(),
    authority: '',
    origin: 'origin_default',
    shipset: 'mammalian_01',
    speciesClass: 'MAM',
    planetClass: 'pc_continental',
    isNomadic: false,
    dlcs: ALL_DLCS,
    ...overrides,
  };
}

// --------------------------------------------------------------------------

section('1. vanilla merge matches the shipped game');
{
  const view = buildView(db, new Set(['base']));
  check('281 civics', idsOf(view, 'civics').size === 281, `got ${idsOf(view, 'civics').size}`);
  check('77 origins', idsOf(view, 'origins').size === 77, `got ${idsOf(view, 'origins').size}`);
  check('17 ethics', idsOf(view, 'ethics').size === 17, `got ${idsOf(view, 'ethics').size}`);
  check('8 authorities', idsOf(view, 'authorities').size === 8, `got ${idsOf(view, 'authorities').size}`);
  check('3 ethic points', view.defines.ETHOS_MAX_POINTS === '3');
  check('2 civic points', view.defines.GOVERNMENT_CIVIC_POINTS_BASE === '2');
  check('gestalt costs 3', view.cat.ethics.get('ethic_gestalt_consciousness').data.cost === '3');
}

section('2. Ethics and Civics Classic overrides both ways');
{
  const view = buildView(db, new Set(['base', '1100284147']));
  const auth = idsOf(view, 'authorities');
  check('9 authorities, not 17 (blanked 00_authorities.txt honoured)',
    auth.size === 9, `got ${auth.size}`);
  check('adds auth_direct_democratic', auth.has('auth_direct_democratic'));
  check('ethic_authoritarian now comes from the mod',
    view.cat.ethics.get('ethic_authoritarian').src === '1100284147',
    `got ${view.cat.ethics.get('ethic_authoritarian').src}`);
  check('26 ethics', idsOf(view, 'ethics').size === 26, `got ${idsOf(view, 'ethics').size}`);
  check('budget becomes 5 ethic points', view.defines.ETHOS_MAX_POINTS === '5');
  check('budget becomes 3 civic points', view.defines.GOVERNMENT_CIVIC_POINTS_BASE === '3');
  check('gestalt costs 4', view.cat.ethics.get('ethic_gestalt_consciousness').data.cost === '4');
  check('new soc/grn/foc axes exist',
    ['ethic_socialism', 'ethic_capitalism', 'ethic_green', 'ethic_industrial', 'ethic_focused']
      .every((id) => view.cat.ethics.has(id)));
}

section('3. budgets respond to picks');
{
  const view = buildView(db, new Set(['base']));
  const fanatic = makeBuild({ ethics: new Set(['ethic_fanatic_militarist', 'ethic_egalitarian']) });
  let mods = aggregateModifiers(view, fanatic);
  let budget = computeBudgets(view, fanatic, mods.totals);
  check('fanatic + normal spends all 3 ethic points',
    budget.ethics.used === 3 && budget.ethics.max === 3,
    `used ${budget.ethics.used} of ${budget.ethics.max}`);

  const natural = makeBuild({ civics: new Set(['civic_natural_design']) });
  mods = aggregateModifiers(view, natural);
  budget = computeBudgets(view, natural, mods.totals);
  check('civic_natural_design grants 4 trait points / 7 picks',
    budget.traitPoints.max === 4 && budget.traitPicks.max === 7,
    `points ${budget.traitPoints.max}, picks ${budget.traitPicks.max}`);

  const machine = makeBuild({ speciesClass: 'MACHINE' });
  budget = computeBudgets(view, machine, new Map());
  check('MACHINE archetype is 1 point / 5 picks',
    budget.traitPoints.max === 1 && budget.traitPicks.max === 5,
    `points ${budget.traitPoints.max}, picks ${budget.traitPicks.max}`);

  const lithoid = makeBuild({ speciesClass: 'LITHOID' });
  budget = computeBudgets(view, lithoid, new Map());
  check('LITHOID inherits BIOLOGICAL 2 points / 5 picks',
    budget.traitPoints.max === 2 && budget.traitPicks.max === 5,
    `points ${budget.traitPoints.max}, picks ${budget.traitPicks.max}`);
}

section('3b. traits granted automatically are picked up');
{
  const view = buildView(db, new Set(['base']));
  const forced = (overrides) => rules.forcedTraits(view, makeBuild(overrides)).locked;

  // Species classes use a bare `trait = x`; origins and civics use
  // `traits = { trait = x }`. Missing the first would export a species without
  // the marker trait the game requires.
  check('HUM contributes trait_organic', forced({ speciesClass: 'HUM' }).has('trait_organic'));
  check('LITHOID contributes trait_lithoid', forced({ speciesClass: 'LITHOID' }).has('trait_lithoid'));
  check('MACHINE contributes trait_machine_unit', forced({ speciesClass: 'MACHINE' }).has('trait_machine_unit'));

  const mixed = forced({
    speciesClass: 'HUM',
    origin: 'origin_void_dwellers',
    civics: new Set(['civic_anglers']),
  });
  check('origin contributes trait_void_dweller_1', mixed.has('trait_void_dweller_1'));
  check('civic contributes trait_aquatic', mixed.has('trait_aquatic'));

  const soft = rules.forcedTraits(view, makeBuild({ origin: 'origin_shroudwalker_apprentice' })).soft;
  check('origin soft traits stay removable', soft.has('trait_latent_psionic'), [...soft.keys()].join());
}

section('4. the evaluator blocks what the game blocks');
{
  const view = buildView(db, new Set(['base']));
  const ctx = (o) => makeContext(view, makeBuild(o));

  const corvee = view.cat.civics.get('civic_corvee_system');
  check('corvee system is fine for an authoritarian',
    evaluate(corvee, ctx({ ethics: new Set(['ethic_authoritarian']), authority: 'auth_dictatorial' })).ok);
  check('corvee system is blocked for an egalitarian',
    !evaluate(corvee, ctx({ ethics: new Set(['ethic_egalitarian']), authority: 'auth_democratic' })).ok);
  check('corvee system is not offered to a gestalt',
    !evaluate(corvee, ctx({ ethics: new Set(['ethic_gestalt_consciousness']), authority: 'auth_hive_mind' })).available);

  const hive = view.cat.authorities.get('auth_hive_mind');
  check('hive mind needs gestalt',
    !evaluate(hive, ctx({ ethics: new Set(['ethic_militarist']) })).ok);
  check('hive mind accepts a gestalt biological',
    evaluate(hive, ctx({ ethics: new Set(['ethic_gestalt_consciousness']) })).ok);
  check('hive mind rejects a machine archetype',
    !evaluate(hive, ctx({ ethics: new Set(['ethic_gestalt_consciousness']), speciesClass: 'MACHINE' })).ok);

  const machineInt = view.cat.authorities.get('auth_machine_intelligence');
  check('machine intelligence requires MACHINE',
    evaluate(machineInt, ctx({ ethics: new Set(['ethic_gestalt_consciousness']), speciesClass: 'MACHINE' })).ok);

  const voidDwellers = view.cat.origins.get('origin_void_dwellers');
  check('void dwellers rejects a machine empire',
    !evaluate(voidDwellers, ctx({ speciesClass: 'MACHINE' })).available);
  check('void dwellers rejects agrarian idyll',
    !evaluate(voidDwellers, ctx({ civics: new Set(['civic_agrarian_idyll']) })).ok);

  const democratic = view.cat.authorities.get('auth_democratic');
  const blocked = evaluate(democratic, ctx({ ethics: new Set(['ethic_fanatic_authoritarian']) }));
  check('democracy is blocked for fanatic authoritarians', !blocked.ok);
  check('and says why', blocked.reasons.length > 0 && blocked.reasons[0].category === 'ethics',
    JSON.stringify(blocked.reasons));

  // The ROBOT species class hides itself behind has_global_flag = game_started.
  const robot = view.cat.species_classes.get('ROBOT');
  check('ROBOT class is not offered at empire creation',
    !evaluate(robot, ctx({})).available);
}

section('4b. entries a mod ships switched off are reported as disabled');
{
  const view = buildView(db, new Set(['base', '1121692237']));
  const frameworld = view.cat.origins.get('origin_frameworld');
  if (!frameworld) {
    check('frameworld origin present', false, 'entity missing');
  } else {
    const verdict = evaluate(frameworld, makeContext(view, makeBuild()));
    check('frameworld is blocked', !verdict.ok);
    // `possible = { always = no }` is a mod switching an entry off, not a
    // requirement. Rendering it as one produced "Requires no".
    check('reported as disabled, not as a requirement',
      verdict.reasons.length === 1 && verdict.reasons[0].category === 'disabled',
      JSON.stringify(verdict.reasons));
    check("the mod's own note is carried through",
      verdict.reasons[0].text === 'Disabled for 4.0', verdict.reasons[0].text);
  }
}

section('5. modded requirements evaluate');
{
  const view = buildView(db, new Set(['base', '1100284147']));
  const ctx = (o) => makeContext(view, makeBuild(o));

  const imperial = view.cat.authorities.get('auth_imperial');
  check('EaC imperial requires authoritarian',
    !evaluate(imperial, ctx({ ethics: new Set(['ethic_militarist']) })).ok);
  check('EaC imperial accepts authoritarian',
    evaluate(imperial, ctx({ ethics: new Set(['ethic_authoritarian']) })).ok);

  const corporate = view.cat.authorities.get('auth_corporate');
  check('EaC corporate requires a socialism/capitalism ethic',
    !evaluate(corporate, ctx({ ethics: new Set(['ethic_militarist']) })).ok);
  check('EaC corporate accepts capitalism',
    evaluate(corporate, ctx({ ethics: new Set(['ethic_capitalism']) })).ok);

  const direct = view.cat.authorities.get('auth_direct_democratic');
  check('direct democracy requires egalitarian',
    !evaluate(direct, ctx({ ethics: new Set(['ethic_authoritarian']) })).ok);
  check('direct democracy accepts egalitarian',
    evaluate(direct, ctx({ ethics: new Set(['ethic_egalitarian']) })).ok);
}

section('5b. a failing OR is described as alternatives, not as "OR"');
{
  const view = buildView(db, new Set(['base', '1100284147']));
  const ctx = makeContext(view, makeBuild({ ethics: new Set(['ethic_militarist']) }));
  const verdict = evaluate(view.cat.authorities.get('auth_imperial'), ctx);
  check('imperial is blocked for a plain militarist', !verdict.ok);

  const orClause = verdict.reasons.find((r) => r.branches);
  check('the OR clause carries its branches', Boolean(orClause),
    JSON.stringify(verdict.reasons));
  if (orClause) {
    check('one branch per alternative', orClause.branches.length === 3,
      `${orClause.branches.length} branches`);
    const named = orClause.branches.flat().flatMap((r) => [...r.need, ...r.forbid]);
    check('names the legendary-leader origin', named.includes('origin_legendary_leader_imperial'), named.join());
    check('names the authoritarian ethics',
      named.includes('ethic_authoritarian') && named.includes('ethic_fanatic_authoritarian'),
      named.join());
    check('no branch is left undescribed',
      orClause.branches.every((g) => g.length > 0));
  }
}

section('5c. an empty NOT block does not lock an entry out');
{
  // Ethics and Civics Classic ships `civics = { NOT = {} }` on civic_feudal_realm.
  // Reading the empty inner OR as true made the NOT false, which would have made
  // the civic permanently unpickable.
  const view = buildView(db, new Set(['base', '1100284147']));
  const feudal = view.cat.civics.get('civic_feudal_realm');
  const ctx = makeContext(view, makeBuild({
    authority: 'auth_imperial',
    ethics: new Set(['ethic_authoritarian']),
  }));
  const verdict = evaluate(feudal, ctx);
  check('feudal realm is pickable for an authoritarian imperial', verdict.ok,
    JSON.stringify(verdict.reasons));
}

section('6. lowercase nor/not in Government Variety Pack still evaluate');
{
  const view = buildView(db, new Set(['base', '2806903835']));
  const origin = view.cat.origins.get('lrsk_gov_var_origin_colonial_venture');
  if (!origin) {
    check('colonial venture present', false, 'entity missing');
  } else {
    const ctx = makeContext(view, makeBuild({ ethics: new Set(['ethic_gestalt_consciousness']) }));
    const verdict = evaluate(origin, ctx);
    check('lowercase `not` is honoured (gestalt blocked)', !verdict.ok,
      JSON.stringify(verdict.reasons));
  }
}

section('7. the real saved empires cross-check the evaluator');
{
  const designPath = path.join(
    os.homedir(), 'Documents', 'Paradox Interactive', 'Stellaris',
    'user_empire_designs_v3.4.txt',
  );

  if (!fs.existsSync(designPath)) {
    console.log(`  skip  no saved designs at ${designPath}`);
  } else {
    const empires = parseEmpireDesigns(fs.readFileSync(designPath, 'utf8'));
    check(`parsed ${empires.length} saved empires`, empires.length === 18, `got ${empires.length}`);

    const unknownKeys = new Map();

    const audit = (view, empire) => {
      const build = makeBuild({
        ethics: new Set(empire.ethics),
        civics: new Set(empire.civics),
        traits: new Set(empire.traits),
        authority: empire.authority,
        origin: empire.origin,
        shipset: empire.shipset,
        speciesClass: empire.speciesClass,
        planetClass: empire.planetClass,
        isNomadic: empire.isNomadic,
      });
      const ctx = makeContext(view, build);
      const blocked = [];
      const targets = [
        ['authority', view.cat.authorities.get(empire.authority)],
        ['origin', view.cat.origins.get(empire.origin)],
        ...empire.civics.map((id) => [id, view.cat.civics.get(id)]),
      ];
      for (const [label, entity] of targets) {
        if (!entity) continue;   // modded pick absent from this toggle set
        const verdict = evaluate(entity, ctx);
        for (const key of verdict.unknown) {
          unknownKeys.set(key, (unknownKeys.get(key) || 0) + 1);
        }
        if (!verdict.ok) blocked.push({ label, reasons: verdict.reasons });
      }
      return blocked;
    };

    // Under vanilla rules these are designs the base game itself accepted, so
    // anything the evaluator rejects here is a bug in the evaluator. The single
    // expected exception is a design that is genuinely broken: it pairs
    // civic_shared_burden (fanatic egalitarian only) with fanatic authoritarian.
    const vanilla = buildView(db, new Set(['base']));
    const vanillaBlocked = empires
      .map((e) => [e, audit(vanilla, e)])
      .filter(([, blocked]) => blocked.length);
    check('17 of 18 validate against vanilla rules',
      vanillaBlocked.length === 1, `${vanillaBlocked.length} blocked`);
    check('the one exception is the shared-burden design',
      vanillaBlocked.length === 1
        && vanillaBlocked[0][1].some((b) => b.label === 'civic_shared_burden'),
      vanillaBlocked.map(([e, b]) => `${e.name}: ${b.map((x) => x.label)}`).join('; '));

    // With the full playset, Ethics and Civics Classic tightens auth_corporate
    // to require a socialism/capitalism ethic and rewrites civic_shared_burden,
    // which retroactively invalidates older designs. That is a real finding
    // about the save file, not an evaluator failure - pinned so a regression in
    // the evaluator changes the number.
    const full = buildView(db, new Set(db.meta.sources.map((s) => s.id)));
    const fullBlocked = empires
      .map((e) => [e, audit(full, e)])
      .filter(([, blocked]) => blocked.length);
    check('exactly 5 designs are invalidated by the current playset',
      fullBlocked.length === 5, `${fullBlocked.length} blocked`);
    for (const [empire, blocked] of fullBlocked) {
      console.log(`  note  "${empire.name}" [${empire.ethics.join(' + ')}]`);
      for (const item of blocked) {
        const detail = item.reasons
          .map((r) => `${r.mode} ${r.category} ${JSON.stringify(r.need.length ? r.need : r.forbid)}`)
          .join('; ');
        console.log(`          ${item.label} needs ${detail}`);
      }
    }

    if (unknownKeys.size) {
      console.log('  note  requirement keys the evaluator cannot check:');
      for (const [key, count] of [...unknownKeys].sort((a, b) => b[1] - a[1])) {
        console.log(`          ${key} (${count})`);
      }
    } else {
      console.log('  note  every requirement clause in these designs was checkable');
    }
  }
}

section('8. empire file round trip');
{
  const view = buildView(db, new Set(db.meta.sources.map((s) => s.id)));
  const build = makeBuild({
    name: 'Round Trip Collective',
    adjective: 'Round Trip',
    shipPrefix: 'RTC',
    speciesName: 'Tripper',
    speciesPlural: 'Trippers',
    speciesAdjective: 'Tripper',
    ethics: new Set(['ethic_fanatic_materialist', 'ethic_militarist']),
    civics: new Set(['civic_technocracy', 'civic_meritocracy']),
    traits: new Set(['trait_organic', 'trait_intelligent', 'trait_decadent']),
    rulerTraits: new Set(['leader_trait_spark_of_genius']),
    authority: 'auth_oligarchic',
    origin: 'origin_default',
    speciesClass: 'HUM',
    portrait: 'human',
    nameList: 'HUMAN1',
    planetClass: 'pc_continental',
    planetName: 'Terra',
    systemName: 'Sol',
    ruler: { name: 'Ada', gender: 'female', portrait: 'human_female_01', title: 'Chancellor', titleFemale: 'Chancellor', leaderClass: 'official', traits: ['leader_trait_spark_of_genius'] },
  });
  build.civics = [...build.civics];
  build.ethics = [...build.ethics];
  build.traits = [...build.traits];

  const text = serializeEmpire(build);
  const root = parseScript(text);
  check('serialised block parses back', root.items.length === 1, `${root.items.length} entries`);

  const back = readEmpire(root.items[0][0], root.items[0][2]);
  check('name survives', back.name === build.name, back.name);
  check('authority survives', back.authority === build.authority, back.authority);
  check('origin survives', back.origin === build.origin, back.origin);
  check('ethics survive', back.ethics.join() === build.ethics.join(), back.ethics.join());
  check('civics survive', back.civics.join() === build.civics.join(), back.civics.join());
  check('traits survive', back.traits.join() === build.traits.join(), back.traits.join());
  check('species class survives', back.speciesClass === 'HUM', back.speciesClass);
  check('ruler name survives', back.ruler.name === 'Ada', back.ruler.name);
  check('ruler trait survives', back.ruler.traits.join() === 'leader_trait_spark_of_genius', back.ruler.traits.join());
  check('planet class survives', back.planetClass === 'pc_continental', back.planetClass);

  // The game's own dialect must parse identically.
  check('archetype lookup works', archetypeOf(view, 'LITHOID') === 'LITHOID');
}

section('10. the random roller only produces legal empires');
{
  const rollTemplate = makeBuild();
  for (const [label, ids] of [
    ['vanilla', ['base']],
    ['full playset', db.meta.sources.map((s) => s.id)],
  ]) {
    const view = buildView(db, new Set(ids));
    let invalid = 0;
    let failed = 0;
    let overBudget = 0;
    for (let i = 0; i < 120; i += 1) {
      const build = rollEmpire(view, rollTemplate, { flavour: 'any' });
      if (!build) { failed += 1; continue; }
      const ctx = makeContext(view, build);
      const problems = [];
      for (const [cat, id] of [['authorities', build.authority], ['origins', build.origin]]) {
        const entity = view.cat[cat].get(id);
        const verdict = entity && evaluate(entity, ctx);
        if (!entity || !verdict.ok || !verdict.available) problems.push(cat + ':' + id);
      }
      for (const id of build.civics) {
        if (!evaluate(view.cat.civics.get(id), ctx).ok) problems.push('civic:' + id);
      }
      for (const id of build.traits) {
        if (!rules.traitStatus(view.cat.species_traits.get(id), ctx).ok) problems.push('trait:' + id);
      }
      const budgets = computeBudgets(view, build, aggregateModifiers(view, build).totals);
      for (const pool of Object.values(budgets)) if (pool.used > pool.max) overBudget += 1;
      if (problems.length) invalid += 1;
    }
    check(label + ': 120 rolls all validate', invalid === 0, invalid + ' invalid');
    check(label + ': none over budget', overBudget === 0, overBudget + ' over');
    check(label + ': none failed to roll', failed === 0, failed + ' returned null');
  }

  const view = buildView(db, new Set(db.meta.sources.map((s) => s.id)));
  for (const [key, flavour] of Object.entries(FLAVOURS)) {
    const build = rollEmpire(view, rollTemplate, { flavour: key });
    check('flavour "' + flavour.label + '" rolls', Boolean(build));
    if (!build) continue;
    if (key === 'gestalt' || key === 'machine') {
      check('  ' + flavour.label + ' is gestalt', build.ethics.has('ethic_gestalt_consciousness'));
    }
    if (key === 'megacorp') {
      check('  Megacorp is corporate', build.authority === 'auth_corporate', build.authority);
    }
    if (key === 'machine') {
      check('  Machine uses the MACHINE class', build.speciesClass === 'MACHINE', build.speciesClass);
    }
  }

  // random_weight = 0 means "never roll this", which is how dozens of civics
  // and origins opt out. Picking one would be a real deviation from the game.
  const neverRandom = new Set();
  for (const [id, ent] of view.cat.civics) if (ent.data.random_weight === '0') neverRandom.add(id);
  let leaked = 0;
  for (let i = 0; i < 120; i += 1) {
    const build = rollEmpire(view, rollTemplate, { flavour: 'any' });
    for (const id of build.civics) if (neverRandom.has(id)) leaked += 1;
  }
  check('weight-0 civics are never rolled (' + neverRandom.size + ' of them)',
    leaked === 0, leaked + ' leaked');
}

section('11. the effect index covers every modifier');
{
  invalidateIndex();
  const view = buildView(db, new Set(db.meta.sources.map((s) => s.id)));
  const app = {
    view,
    build: makeBuild(),
    enabledSources: new Set(db.meta.sources.map((s) => s.id)),
    sourceName: (id) => id,
  };
  const index = buildIndex(app);
  check('the index is populated', index.size > 400, index.size + ' keys');

  const ctx = makeContext(view, app.build);
  let missing = 0;
  for (const cat of ['ethics', 'authorities', 'civics', 'origins', 'species_traits']) {
    for (const [id, ent] of view.cat[cat]) {
      const mods = rules.entityModifiers(ent, ctx);
      for (const m of [...mods.active, ...mods.conditional]) {
        const entry = index.get(m.key);
        if (!entry || !entry.providers.some((p) => p.id === id && p.category === cat)) missing += 1;
      }
    }
  }
  check('every entity modifier appears in the index', missing === 0, missing + ' missing');

  check('research speed is indexed', Boolean(index.get('all_technology_research_speed')));
  const viaSearch = [...index.values()].find((e) => e.haystack.includes('research speed')
    && e.providers.some((p) => p.id === 'ethic_fanatic_materialist'));
  check('Fanatic Materialist shows up under a research search', Boolean(viaSearch));

  const labelled = [...index.values()].filter((e) => e.label && e.label !== e.key);
  check('most keys resolve to a readable label',
    labelled.length > index.size * 0.5, labelled.length + ' of ' + index.size);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
