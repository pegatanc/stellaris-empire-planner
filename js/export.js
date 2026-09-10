// Getting a build back out: a playable empire file, a share link, a build sheet.

import { serializeEmpire } from './empirefile.js';
import { formatModifier, modifierName, plainText } from './loc.js';
import { arr } from './util.js';
import * as rules from './rules.js';

const nameOf = (view, id) => {
  const text = view.loc(id);
  return text ? plainText(view, text) : id;
};

/** Build state -> the flat shape empirefile.js writes. */
export function toEmpirePayload(app) {
  const { view, build } = app;
  const forced = rules.forcedTraits(view, build);
  const traits = [...new Set([...forced.locked.keys(), ...forced.soft.keys(), ...build.traits])];
  const government = rules.matchingGovernments(view, app.ctx)[0];
  const secondaryInfo = rules.secondarySpecies(view, build);

  const name = build.name || 'Unnamed Empire';
  // Chain the species fallbacks off the resolved name, not the raw field, or a
  // blank species name leaves the plural and adjective saying "Unnamed".
  const speciesName = build.speciesName || name;

  return {
    name,
    adjective: build.adjective || name,
    shipPrefix: build.shipPrefix || '',
    speciesClass: build.speciesClass,
    speciesName,
    speciesPlural: build.speciesPlural || speciesName,
    speciesAdjective: build.speciesAdjective || speciesName,
    portrait: build.portrait,
    nameList: build.nameList,
    traits,
    ethics: [...build.ethics],
    civics: [...build.civics],
    origin: build.origin,
    authority: build.authority,
    government: government ? government.id : '',
    shipset: build.shipset,
    cityset: build.shipset,
    planetClass: build.planetClass,
    planetName: build.planetName || 'Homeworld',
    systemName: build.systemName || 'Home',
    room: build.room,
    advisorVoice: build.advisorVoice,
    isNomadic: build.isNomadic,
    ruler: { ...build.ruler, traits: [...build.rulerTraits] },
    flagColors: build.flagColors,
    // Origins like Necrophage and civics like Driven Assimilator design a second
    // species too; omitting it would export an incomplete empire.
    secondary: secondaryInfo.required ? secondaryPayload(view, build, secondaryInfo) : null,
  };
}

function secondaryPayload(view, build, info) {
  const secondary = build.secondary || {};
  const speciesClass = secondary.speciesClass || 'HUM';
  const classEntity = view.cat.species_classes.get(speciesClass);
  const marker = arr(classEntity?.data.trait);
  const traits = [...new Set([...marker, ...info.forced.keys(), ...(secondary.traits || [])])];
  const speciesName = secondary.name || 'Secondary';
  return {
    speciesClass,
    portrait: secondary.portrait || '',
    nameList: secondary.nameList || 'HUMAN1',
    name: speciesName,
    plural: secondary.plural || speciesName,
    adjective: secondary.adjective || speciesName,
    traits,
  };
}

export function exportEmpireFile(app) {
  return serializeEmpire(toEmpirePayload(app));
}

// --------------------------------------------------------------------------
// Share link
// --------------------------------------------------------------------------

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeBuild(app) {
  const { build } = app;
  const allDlc = app.db.options.dlcs.length === build.dlcs.size;
  const payload = {
    v: 1,
    n: build.name, a: build.adjective, p: build.shipPrefix,
    sc: build.speciesClass, sn: build.speciesName, sl: build.speciesPlural,
    sj: build.speciesAdjective, po: build.portrait, nl: build.nameList,
    gs: build.shipset, pc: build.planetClass, pn: build.planetName, sy: build.systemName,
    e: [...build.ethics], au: build.authority, c: [...build.civics], o: build.origin,
    t: [...build.traits], rt: [...build.rulerTraits],
    s2: build.secondary ? { ...build.secondary, traits: [...build.secondary.traits] } : null,
    r: build.ruler, rm: build.room, av: build.advisorVoice,
    m: [...app.enabledSources],
  };
  if (!allDlc) payload.d = [...build.dlcs];
  return toBase64Url(JSON.stringify(payload));
}

export function decodeBuild(code) {
  const payload = JSON.parse(fromBase64Url(code));
  if (payload.v !== 1) throw new Error(`unsupported share code version ${payload.v}`);
  return payload;
}

export function applyEncoded(app, payload) {
  const { build } = app;
  const set = (key, value, fallback) => { build[key] = value ?? fallback ?? build[key]; };
  set('name', payload.n);
  set('adjective', payload.a);
  set('shipPrefix', payload.p);
  set('speciesClass', payload.sc);
  set('speciesName', payload.sn);
  set('speciesPlural', payload.sl);
  set('speciesAdjective', payload.sj);
  set('portrait', payload.po);
  set('nameList', payload.nl);
  set('shipset', payload.gs);
  set('planetClass', payload.pc);
  set('planetName', payload.pn);
  set('systemName', payload.sy);
  set('authority', payload.au);
  set('origin', payload.o);
  set('room', payload.rm);
  set('advisorVoice', payload.av);
  build.ethics = new Set(payload.e || []);
  build.civics = new Set(payload.c || []);
  build.traits = new Set(payload.t || []);
  build.rulerTraits = new Set(payload.rt || []);
  if (payload.s2) {
    build.secondary = { ...payload.s2, traits: new Set(payload.s2.traits || []) };
  }
  if (payload.r) build.ruler = { ...build.ruler, ...payload.r, traits: undefined };
  if (payload.d) build.dlcs = new Set(payload.d);
  if (payload.m) app.setSources(new Set(payload.m));
}

// --------------------------------------------------------------------------
// Build sheet
// --------------------------------------------------------------------------

export function exportJSON(app) {
  const { view } = app;
  const payload = toEmpirePayload(app);
  const modifiers = {};
  for (const [key, value] of app.modifiers.totals) modifiers[key] = value;
  return JSON.stringify({
    generated: new Date().toISOString(),
    gameVersion: app.db.meta.game_version,
    mods: [...app.enabledSources]
      .filter((id) => id !== 'base')
      .map((id) => app.sourceName(id)),
    empire: payload,
    labels: Object.fromEntries(
      [...payload.ethics, ...payload.civics, payload.origin, payload.authority, ...payload.traits]
        .filter(Boolean)
        .map((id) => [id, nameOf(view, id)]),
    ),
    modifiers,
    budgets: app.budgets,
    issues: app.issues(),
  }, null, 2);
}

export function exportMarkdown(app) {
  const { view, build, budgets } = app;
  const payload = toEmpirePayload(app);
  const list = (ids) => (ids.length ? ids.map((id) => nameOf(view, id)).join(', ') : '—');
  const government = rules.matchingGovernments(view, app.ctx)[0];

  const lines = [
    `# ${payload.name}`,
    '',
    `*${payload.speciesPlural} · ${nameOf(view, build.speciesClass)} · ${rules.archetypeOf(view, build.speciesClass)}*`,
    '',
    `Generated with the Stellaris Empire Planner against ${app.db.meta.game_version}.`,
    '',
    '## Empire',
    '',
    `| | |`,
    `|---|---|`,
    `| Government | ${government ? nameOf(view, government.id) : '—'} |`,
    `| Authority | ${nameOf(view, build.authority)} |`,
    `| Ethics | ${list([...build.ethics])} |`,
    `| Civics | ${list([...build.civics])} |`,
    `| Origin | ${nameOf(view, build.origin)} |`,
    `| Ship appearance | ${nameOf(view, build.shipset)} |`,
    `| Homeworld | ${payload.planetName} (${nameOf(view, build.planetClass)}) in ${payload.systemName} |`,
    `| Species traits | ${list([...build.traits])} |`,
    `| Granted traits | ${list([...rules.forcedTraits(view, build).locked.keys()])} |`,
    `| Ruler traits | ${list([...build.rulerTraits])} |`,
    '',
    '## Budget',
    '',
    `| Pool | Used | Available |`,
    `|---|---|---|`,
    `| Ethic points | ${budgets.ethics.used} | ${budgets.ethics.max} |`,
    `| Civics | ${budgets.civics.used} | ${budgets.civics.max} |`,
    `| Trait points | ${budgets.traitPoints.used} | ${budgets.traitPoints.max} |`,
    `| Trait picks | ${budgets.traitPicks.used} | ${budgets.traitPicks.max} |`,
    '',
    '## Modifiers',
    '',
  ];

  const totals = [...app.modifiers.totals.entries()]
    .filter(([, value]) => value)
    .sort((a, b) => modifierName(view, a[0]).localeCompare(modifierName(view, b[0])));

  if (!totals.length) {
    lines.push('_No modifiers from the current picks._');
  } else {
    lines.push('| Modifier | Total |', '|---|---|');
    for (const [key, value] of totals) {
      lines.push(`| ${stripTags(modifierName(view, key))} | ${formatModifier(view, key, value)} |`);
    }
  }

  const mods = [...app.enabledSources].filter((id) => id !== 'base');
  lines.push('', '## Mods enabled', '');
  lines.push(mods.length ? mods.map((id) => `- ${app.sourceName(id)}`).join('\n') : '_Vanilla only._');

  const issues = app.issues();
  if (issues.length) {
    lines.push('', '## Problems', '');
    for (const issue of issues) lines.push(`- **${issue.label}** — ${issue.text}`);
  }

  return lines.join('\n');
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, '').replace(/\$[^$]*\$/g, '').trim();
}

// --------------------------------------------------------------------------
// Saved builds
// --------------------------------------------------------------------------

const STORAGE_KEY = 'stellaris-empire-planner.builds';

export function loadSlots() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveSlot(app, label) {
  const slots = loadSlots().filter((slot) => slot.label !== label);
  slots.unshift({
    label,
    saved: new Date().toISOString(),
    code: encodeBuild(app),
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slots.slice(0, 40)));
    return true;
  } catch {
    return false;
  }
}

export function deleteSlot(label) {
  const slots = loadSlots().filter((slot) => slot.label !== label);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
  } catch {
    /* storage unavailable; nothing to clean up */
  }
}
