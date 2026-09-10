// Deep audit: does what the planner shows match what the game files say?
//
//   node tools/audit.mjs [--verbose]
//
// verify.mjs pins behaviour with hand-written cases. This goes the other way:
// it re-reads the raw game and mod files and compares them against the shipped
// JSON and the rendered output, across every entity rather than a sample. It
// reports findings; it does not assert, because some findings are facts about
// the mods rather than bugs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildView } from '../js/data.js';
import { makeContext, evaluate, entityModifiers, traitCost } from '../js/rules.js';
import { reasonText, nameOf } from '../js/ui.js';
import { formatModifier, isPercentModifier, renderText } from '../js/loc.js';
import { parseScript, readEmpire, parseEmpireDesigns } from '../js/empirefile.js';

const VERBOSE = process.argv.includes('--verbose');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME = process.env.STELLARIS_DIR
  || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stellaris';
const USERDIR = path.join(os.homedir(), 'Documents', 'Paradox Interactive', 'Stellaris');

// The browser modules touch document for plain-text extraction.
globalThis.document = {
  createElement: () => ({
    set innerHTML(v) { this._v = v; },
    get textContent() { return String(this._v || '').replace(/<[^>]*>/g, ''); },
  }),
};

const readJSON = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${name}.json`), 'utf8'));
const db = {
  meta: readJSON('meta'), entities: readJSON('entities'), loc: readJSON('loc'),
  defines: readJSON('defines'), options: readJSON('options'), icons: readJSON('icons'),
};
db.order = Object.fromEntries(db.meta.sources.map((s) => [s.id, s.order]));

const ALL = new Set(db.meta.sources.map((s) => s.id));
const DLCS = new Set(db.options.dlcs.map((d) => d.name));
const fullView = buildView(db, ALL);

let findings = 0;
let sections = 0;

function section(title) {
  sections += 1;
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}
function ok(msg) { console.log(`  ok    ${msg}`); }
function bad(msg, detail) {
  findings += 1;
  console.log(`  FLAG  ${msg}`);
  if (detail) console.log(`          ${String(detail).slice(0, 400)}`);
}
function note(msg) { console.log(`  note  ${msg}`); }

// Findings already traced to the mods' own data rather than to this tool. They
// are reported as "known" so the audit still shouts if the set changes.
const KNOWN = {
  prescripted: {
    humans1: 'vanilla UN of Earth: EaC retunes civic_beacon_of_liberty to need a Competitive ethic',
    humans3: "EaC's own empire takes civic_philosopher_king AND civic_technocracy, which its own philosopher_king forbids",
  },
  unnamed: {
    civic_caravaneer_caravansary: 'vanilla caravaneer-only civic, never shown to a player',
    origin_eawafkaiser: 'Gigastructural placeholder, gated off with potential = { always = no }',
    trait_pc_tidallylocked_preference: 'Real Space - New Frontiers ships no loc key for it',
  },
};

function makeBuild(o = {}) {
  return {
    ethics: new Set(), civics: new Set(), traits: new Set(), rulerTraits: new Set(),
    authority: 'auth_democratic', origin: 'origin_default', shipset: 'mammalian_01',
    speciesClass: 'HUM', planetClass: 'pc_continental', isNomadic: false, dlcs: DLCS,
    ...o,
  };
}

// --------------------------------------------------------------------------

const roots = new Map([['base', GAME]]);
for (const src of db.meta.sources) {
  if (src.id === 'base') continue;
  const desc = path.join(USERDIR, 'mod', `${src.steam_id ? `ugc_${src.steam_id}` : src.id}.mod`);
  if (!fs.existsSync(desc)) continue;
  const blk = parseScript(fs.readFileSync(desc, 'utf8'));
  const entry = blk.items.find(([k]) => k === 'path');
  if (entry) roots.set(src.id, entry[2]);
}

section('1. Source files: does the extract cover what is on disk?');
{

  const DIRS = {
    ethics: 'common/ethics',
    authorities: 'common/governments/authorities',
    civics: 'common/governments/civics',
    species_classes: 'common/species_classes',
    graphical_culture: 'common/graphical_culture',
    planet_classes: 'common/planet_classes',
  };

  let missing = 0;
  for (const [srcId, root] of roots) {
    for (const [cat, rel] of Object.entries(DIRS)) {
      const dir = path.join(root, rel);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.txt') || /readme|documentation|_example/i.test(file)) continue;
        const relPath = `${rel}/${file}`;
        const providers = db.meta.files[relPath];
        if (!providers || !providers.includes(srcId)) {
          bad(`file on disk but not in the extract: ${srcId} ${relPath}`);
          missing += 1;
        }
      }
    }
  }
  if (!missing) ok('every ethics/authority/civic/species/shipset/planet file on disk is indexed');
}

// --------------------------------------------------------------------------

section('2. Unresolved macros and placeholders in the shipped data');
{
  const leftoverVar = [];
  const leftoverParam = [];
  const leftoverInline = [];

  const walk = (node, trail) => {
    if (typeof node === 'string') {
      if (/^-?@/.test(node)) leftoverVar.push(`${trail} = ${node}`);
      if (/\$[A-Za-z_][A-Za-z_0-9]*\$/.test(node) && !trail.includes('description')
          && !trail.includes('custom_tooltip') && !trail.includes('.text')) {
        leftoverParam.push(`${trail} = ${node}`);
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${trail}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'inline_script') leftoverInline.push(trail);
        walk(v, `${trail}.${k}`);
      }
    }
  };

  for (const [cat, items] of Object.entries(db.entities)) {
    for (const ent of items) walk(ent.data, `${cat}/${ent.id}`);
  }

  if (leftoverVar.length) {
    bad(`${leftoverVar.length} unresolved @scripted_variables`, leftoverVar.slice(0, 5).join(' | '));
  } else ok('no unresolved @scripted_variables');

  if (leftoverInline.length) {
    bad(`${leftoverInline.length} unexpanded inline_script blocks`, leftoverInline.slice(0, 5).join(' | '));
  } else ok('no unexpanded inline_script blocks');

  if (leftoverParam.length) {
    note(`${leftoverParam.length} values still contain $PARAM$ (may be legitimate loc refs)`);
    if (VERBOSE) leftoverParam.slice(0, 20).forEach((x) => console.log(`          ${x}`));
  } else ok('no leftover $PARAM$ substitutions');
}

// --------------------------------------------------------------------------

section('3. Modifier values match the raw files');
{
  // Re-read the raw definition for a large sample and compare every number.
  const rawCache = new Map();
  const rootFor = (srcId) => roots.get(srcId) || GAME;

  const rawEntity = (ent) => {
    const key = `${ent.src}|${ent.file}`;
    if (!rawCache.has(key)) {
      const full = path.join(rootFor(ent.src), ent.file);
      rawCache.set(key, fs.existsSync(full) ? parseScript(fs.readFileSync(full, 'utf8')) : null);
    }
    const root = rawCache.get(key);
    if (!root) return null;
    let found = null;
    for (const [k, , v] of root.items) if (k === ent.id) found = v;   // last wins
    return found;
  };

  // Build an independent @variable table straight from the files, rather than
  // trusting the extractor's - the point is to check it, not agree with it.
  const vars = {};
  for (const [, root] of roots) {
    const dir = path.join(root, 'common', 'scripted_variables');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.txt')) continue;
      const blk = parseScript(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const [k, , v] of blk.items) if (k.startsWith('@') && typeof v === 'string') vars[k] = v;
    }
  }
  for (let pass = 0; pass < 4; pass += 1) {
    for (const [k, v] of Object.entries(vars)) if (vars[v] !== undefined) vars[k] = vars[v];
  }
  const rawNumbers = (block) => {
    const out = new Map();
    for (const [k, , v] of block.items || []) {
      if (typeof v !== 'string') continue;
      let text = v;
      if (text.startsWith('@') && vars[text] !== undefined) text = vars[text];
      const n = parseFloat(text);
      if (Number.isFinite(n) && /^-?[\d.]+$/.test(String(text))) out.set(k, n);  // Map keeps the last
    }
    return out;
  };

  let compared = 0;
  let mismatched = 0;
  let skippedVars = 0;
  const cats = ['ethics', 'authorities', 'civics', 'origins', 'species_traits'];
  for (const cat of cats) {
    for (const ent of db.entities[cat]) {
      const raw = rawEntity(ent);
      if (!raw) continue;
      for (const field of ['modifier', 'country_modifier']) {
        const rawBlocks = raw.items.filter(([k]) => k === field).map(([, , v]) => v);
        const shippedBlocks = Array.isArray(ent.data[field]) ? ent.data[field]
          : (ent.data[field] ? [ent.data[field]] : []);
        rawBlocks.forEach((block, i) => {
          const shipped = shippedBlocks[i];
          if (!shipped) return;
          for (const [key, value] of rawNumbers(block)) {
            const raw = shipped[key];
            const got = parseFloat(Array.isArray(raw) ? raw[raw.length - 1] : raw);
            if (!Number.isFinite(got)) {
              if (typeof raw === 'string' && raw.startsWith('@')) skippedVars += 1;
              continue;
            }
            compared += 1;
            if (Math.abs(got - value) > 1e-9) {
              mismatched += 1;
              bad(`${cat}/${ent.id} ${field}.${key}: shipped ${got}, file says ${value}`);
            }
          }
        });
      }
    }
  }
  if (skippedVars) note(`${skippedVars} values are unresolved @variables (see section 2)`);
  if (!compared) bad('the comparison examined nothing - the audit itself is broken');
  else if (!mismatched) ok(`${compared} modifier numbers match their source files exactly`);
}

// --------------------------------------------------------------------------

section('4. Costs and budgets match the files');
{
  const vanilla = buildView(db, new Set(['base']));
  const eac = buildView(db, new Set(['base', '1100284147']));

  const expectVanilla = {
    ethic_militarist: 1, ethic_fanatic_militarist: 2, ethic_gestalt_consciousness: 3,
    ethic_pacifist: 1, ethic_xenophile: 1, ethic_fanatic_materialist: 2,
  };
  let costOk = true;
  for (const [id, want] of Object.entries(expectVanilla)) {
    const got = parseFloat(vanilla.cat.ethics.get(id)?.data.cost);
    if (got !== want) { bad(`vanilla ${id} cost ${got}, expected ${want}`); costOk = false; }
  }
  if (costOk) ok('vanilla ethic costs are 1 / 2 / 3 as shipped');

  const defs = [
    ['vanilla ETHOS_MAX_POINTS', vanilla.defines.ETHOS_MAX_POINTS, '3'],
    ['vanilla GOVERNMENT_CIVIC_POINTS_BASE', vanilla.defines.GOVERNMENT_CIVIC_POINTS_BASE, '2'],
    ['EaC ETHOS_MAX_POINTS', eac.defines.ETHOS_MAX_POINTS, '5'],
    ['EaC GOVERNMENT_CIVIC_POINTS_BASE', eac.defines.GOVERNMENT_CIVIC_POINTS_BASE, '3'],
    ['EaC gestalt cost', eac.cat.ethics.get('ethic_gestalt_consciousness').data.cost, '4'],
  ];
  let defOk = true;
  for (const [label, got, want] of defs) {
    if (got !== want) { bad(`${label} = ${got}, expected ${want}`); defOk = false; }
  }
  if (defOk) ok('point budgets match the defines in the files');

  // Every trait cost must be a plain number the designer can spend.
  let weird = 0;
  for (const [id, ent] of fullView.cat.species_traits) {
    const c = traitCost(ent);
    if (!Number.isFinite(c)) { bad(`trait ${id} has a non-numeric cost`, JSON.stringify(ent.data.cost)); weird += 1; }
  }
  if (!weird) ok(`${fullView.cat.species_traits.size} species traits have numeric costs`);
}

// --------------------------------------------------------------------------

section('5. Prescripted empires the game ships must all validate');
{
  // 53 vanilla empires plus the mods' replacements - designs Paradox and the
  // mod authors assert are legal. A far bigger corpus than the saved designs.
  const empires = new Map();     // key -> {empire, src}
  for (const [srcId, root] of roots) {
    const dir = path.join(root, 'prescripted_countries');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.txt')) continue;
      const parsed = parseScript(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const [key, , value] of parsed.items) {
        if (typeof value !== 'object' || key === 'default') continue;
        empires.set(key, { empire: readEmpire(key, value), src: srcId });
      }
    }
  }
  note(`${empires.size} prescripted empires found across base game and mods`);

  let checked = 0;
  let failed = 0;
  const failures = [];
  for (const [key, { empire, src }] of empires) {
    if (!empire.authority || !empire.ethics.length) continue;   // fallen empires etc.
    const build = makeBuild({
      ethics: new Set(empire.ethics), civics: new Set(empire.civics),
      traits: new Set(empire.traits), authority: empire.authority,
      origin: empire.origin, shipset: empire.shipset || 'mammalian_01',
      speciesClass: empire.speciesClass || 'HUM',
      planetClass: empire.planetClass || 'pc_continental',
      isNomadic: empire.isNomadic,
    });
    const ctx = makeContext(fullView, build);
    const problems = [];
    const targets = [
      ['authority', fullView.cat.authorities.get(empire.authority)],
      ['origin', fullView.cat.origins.get(empire.origin)],
      ...empire.civics.map((id) => [id, fullView.cat.civics.get(id)]),
    ];
    for (const [label, entity] of targets) {
      if (!entity) continue;
      const verdict = evaluate(entity, ctx);
      if (!verdict.ok) {
        problems.push(`${label}: ${verdict.reasons.map((r) => reasonText(fullView, r)).join('; ')}`);
      }
    }
    checked += 1;
    if (problems.length) {
      failed += 1;
      failures.push(`${key} [${src}] ${empire.authority}/${empire.origin} — ${problems.join(' | ')}`);
    }
  }
  console.log(`  checked ${checked} playable prescripted empires`);
  const unexpected = failures.filter((f) => !KNOWN.prescripted[f.split(' ')[0]]);
  if (!failed) ok('every one validates');
  else if (!unexpected.length) {
    ok(`${checked - failed} validate; ${failed} known mod inconsistencies`);
    failures.forEach((f) => {
      const key = f.split(' ')[0];
      console.log(`          known: ${f}`);
      console.log(`                 ${KNOWN.prescripted[key]}`);
    });
  } else {
    bad(`${unexpected.length} prescripted empires newly fail`);
    unexpected.slice(0, VERBOSE ? 99 : 12).forEach((f) => console.log(`          ${f}`));
  }
}

// --------------------------------------------------------------------------

section('6. Display: names, icons, descriptions');
{
  const SELECTABLE = ['ethics', 'authorities', 'civics', 'origins', 'species_traits'];
  const noName = [];
  const noIcon = [];
  for (const cat of SELECTABLE) {
    for (const [id, ent] of fullView.cat[cat]) {
      if (cat !== 'ethics') {
        const verdict = evaluate(ent, makeContext(fullView, makeBuild()));
        // Only entries a player could ever meet need presentation.
        if (!verdict.available && ent.data.playable) continue;
      }
      if (!fullView.loc(id)) noName.push(`${cat}/${id}`);
      if (!fullView.icon(id)) noIcon.push(`${cat}/${id}`);
    }
  }
  const newlyUnnamed = noName.filter((x) => !KNOWN.unnamed[x.split('/')[1]]);
  if (!noName.length) ok('every selectable entity has a localised name');
  else if (!newlyUnnamed.length) {
    ok(`${noName.length} entities have no name, all known mod/game gaps`);
    for (const x of noName) console.log(`          known: ${x} - ${KNOWN.unnamed[x.split('/')[1]]}`);
  } else {
    bad(`${newlyUnnamed.length} entities newly have no display name`, newlyUnnamed.join(', '));
  }

  if (noIcon.length) {
    note(`${noIcon.length} entities have no icon (a coloured placeholder is shown)`);
    if (VERBOSE) console.log(`          ${noIcon.slice(0, 30).join(', ')}`);
  } else ok('every selectable entity has an icon');

  // Referenced loc keys that never resolve.
  const dangling = new Set();
  for (const cat of SELECTABLE) {
    for (const [, ent] of fullView.cat[cat]) {
      for (const field of ['description', 'negative_description', 'custom_tooltip_with_modifiers']) {
        const key = ent.data[field];
        if (typeof key === 'string' && !fullView.loc(key)) dangling.add(key);
      }
      for (const tag of (ent.data.tags?.__list || [])) {
        if (!fullView.loc(tag)) dangling.add(tag);
      }
    }
  }
  if (dangling.size) {
    note(`${dangling.size} referenced loc keys do not resolve (mod text gaps)`);
    if (VERBOSE) console.log(`          ${[...dangling].slice(0, 25).join(', ')}`);
  } else ok('every referenced description and tag key resolves');
}

// --------------------------------------------------------------------------

section('6b. Rendered text is clean');
{
  // Every description and tag, rendered then stripped back to text. Markup that
  // survives means a reference did not resolve, which the reader sees as a raw
  // key or a gap mid-sentence.
  const strip = (html) => html.replace(/<br>/g, String.fromCharCode(10)).replace(/<[^>]*>/g, '');
  const counts = { dollar: [], bracket: [], pound: [], section: [] };
  let rendered = 0;

  for (const cat of ['ethics', 'authorities', 'civics', 'origins', 'species_traits', 'leader_traits']) {
    for (const [id, ent] of fullView.cat[cat]) {
      const bits = [];
      if (ent.data.description) bits.push(fullView.loc(ent.data.description));
      bits.push(fullView.loc(`${id}_desc`));
      for (const tag of (ent.data.tags?.__list || [])) bits.push(fullView.loc(tag));
      for (const raw of bits.filter(Boolean)) {
        rendered += 1;
        const out = strip(renderText(fullView, raw));
        if (/\$[A-Za-z_]/.test(out)) counts.dollar.push(`${cat}/${id}`);
        if (/\[[^\]]*\]/.test(out)) counts.bracket.push(`${cat}/${id}`);
        if (out.includes('£')) counts.pound.push(`${cat}/${id}`);
        if (out.includes('§')) counts.section.push(`${cat}/${id}`);
      }
    }
  }

  const labels = {
    dollar: 'unresolved $KEY$ references',
    bracket: 'unresolved [concept] links',
    pound: 'stray icon delimiters',
    section: 'stray colour codes',
  };
  let dirty = 0;
  for (const [kind, hits] of Object.entries(counts)) {
    if (hits.length) {
      bad(`${hits.length} strings with ${labels[kind]}`, [...new Set(hits)].slice(0, 6).join(', '));
      dirty += 1;
    }
  }
  if (!dirty) ok(`${rendered} rendered strings contain no leftover markup`);

  // An inline icon that resolves to nothing leaves a visible hole in a sentence.
  const tokens = new Set();
  const allValues = Object.values(db.loc.single)
    .concat(Object.values(db.loc.multi).map((v) => v[v.length - 1][1]));
  for (const value of allValues) {
    for (const m of value.matchAll(/£([A-Za-z0-9_]+)/g)) tokens.add(m[1]);
  }
  const noSprite = [...tokens].filter((t) => !db.icons.cells[`text_${t}`]);
  if (noSprite.length > 12) {
    bad(`${noSprite.length} of ${tokens.size} inline icon tokens have no sprite`,
      noSprite.slice(0, 10).join(', '));
  } else {
    ok(`${tokens.size - noSprite.length} of ${tokens.size} inline icon tokens resolve`);
    if (noSprite.length) note(`no art shipped for: ${noSprite.join(', ')}`);
  }
}

// --------------------------------------------------------------------------

section('7. Requirement coverage across every entity');
{
  const contexts = [
    makeBuild({}),
    makeBuild({ ethics: new Set(['ethic_gestalt_consciousness']), authority: 'auth_hive_mind' }),
    makeBuild({ ethics: new Set(['ethic_fanatic_militarist', 'ethic_authoritarian']), authority: 'auth_imperial' }),
    makeBuild({ speciesClass: 'MACHINE', authority: 'auth_machine_intelligence', ethics: new Set(['ethic_gestalt_consciousness']) }),
    makeBuild({ authority: 'auth_corporate', ethics: new Set(['ethic_capitalism']) }),
  ].map((b) => makeContext(fullView, b));

  let blocked = 0;
  let undescribed = 0;
  const unknownKeys = new Map();
  for (const cat of ['authorities', 'civics', 'origins']) {
    for (const [, ent] of fullView.cat[cat]) {
      for (const ctx of contexts) {
        const verdict = evaluate(ent, ctx);
        for (const key of verdict.unknown) unknownKeys.set(key, (unknownKeys.get(key) || 0) + 1);
        if (verdict.ok) continue;
        blocked += 1;
        if (!verdict.reasons.length) { undescribed += 1; continue; }
        for (const r of verdict.reasons) {
          if (reasonText(fullView, r).startsWith('Blocked by')) undescribed += 1;
        }
      }
    }
  }
  console.log(`  ${blocked} blocked verdicts across 5 builds`);
  if (undescribed) bad(`${undescribed} clauses could not be described`);
  else ok('every blocked pick explains itself');

  if (unknownKeys.size) {
    note(`${unknownKeys.size} requirement keys are not understood (these drive the "unverified" badge)`);
    for (const [k, c] of [...unknownKeys].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`          ${k} (${c} occurrences)`);
    }
  } else ok('no unverifiable requirement keys anywhere');
}

// --------------------------------------------------------------------------

section('8. Percentage vs flat rendering');
{
  const suspicious = [];
  const seen = new Map();
  for (const cat of ['ethics', 'authorities', 'civics', 'origins', 'species_traits']) {
    for (const [, ent] of fullView.cat[cat]) {
      for (const m of entityModifiers(ent, makeContext(fullView, makeBuild())).active) {
        if (!seen.has(m.key)) seen.set(m.key, []);
        seen.get(m.key).push(m.value);
      }
    }
  }
  for (const [key, values] of seen) {
    const pct = isPercentModifier(fullView, key);
    const big = Math.max(...values.map(Math.abs));
    if (pct && big >= 3 && !key.endsWith('_mult')) suspicious.push(`${key} -> ${formatModifier(fullView, key, big)}`);
    if (!pct && values.some((v) => v !== Math.trunc(v) && Math.abs(v) < 1) && !key.endsWith('_add')) {
      suspicious.push(`${key} flat but fractional: ${values.filter((v) => Math.abs(v) < 1)[0]}`);
    }
  }
  console.log(`  ${seen.size} distinct modifier keys in use`);
  if (suspicious.length) {
    note(`${suspicious.length} keys worth an eyeball`);
    suspicious.slice(0, VERBOSE ? 99 : 10).forEach((s) => console.log(`          ${s}`));
  } else ok('no percentage/flat classification looks wrong');
}

// --------------------------------------------------------------------------

section('9. Saved designs round trip');
{
  const designs = path.join(USERDIR, 'user_empire_designs_v3.4.txt');
  if (!fs.existsSync(designs)) note('no saved designs to check');
  else {
    const empires = parseEmpireDesigns(fs.readFileSync(designs, 'utf8'));
    let missingRefs = 0;
    for (const e of empires) {
      const refs = [
        ['authority', e.authority, 'authorities'],
        ['origin', e.origin, 'origins'],
        ...e.civics.map((c) => ['civic', c, 'civics']),
        ...e.traits.map((t) => ['trait', t, 'species_traits']),
        ['species class', e.speciesClass, 'species_classes'],
      ];
      for (const [label, id, cat] of refs) {
        if (id && !fullView.cat[cat].has(id)) {
          bad(`"${e.name}" references a ${label} the merged data does not have: ${id}`);
          missingRefs += 1;
        }
      }
    }
    if (!missingRefs) ok(`all ${empires.length} saved designs reference only ids present in the playset`);
  }
}

console.log(`\n${'='.repeat(72)}`);
console.log(findings === 0
  ? `Audit clean across ${sections} sections.`
  : `${findings} finding(s) across ${sections} sections.`);
process.exit(0);
