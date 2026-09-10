// Reading and writing Stellaris empire designs.
//
// `user_empire_designs_v3.4.txt` is the same Clausewitz grammar as the game
// files, but written back in a distinct dialect: `key=value` with no spaces,
// blocks opening on the following line, entries keyed by the quoted display
// name, and every localisable string wrapped as `{ key="..." literal=yes }`
// rather than left as a bare string. Round-tripping has to match that shape or
// the launcher rejects the file.

const TOKEN = /\s+|#[^\n]*|"(?:[^"\\]|\\.)*"|[{}]|>=|<=|!=|==|=|>|<|[^\s{}=<>#"]+/y;
const OPS = new Set(['=', '==', '>=', '<=', '!=', '>', '<']);

function unquote(token) {
  if (token.length >= 2 && token[0] === '"' && token[token.length - 1] === '"') {
    return token.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return token;
}

function tokenize(text) {
  const out = [];
  let pos = 0;
  while (pos < text.length) {
    TOKEN.lastIndex = pos;
    const match = TOKEN.exec(text);
    if (!match) { pos += 1; continue; }
    pos = TOKEN.lastIndex;
    const token = match[0];
    if (/^\s/.test(token) || token[0] === '#') continue;
    out.push(token);
  }
  return out;
}

/** Parse into { items: [[key, op, value]], bare: [string] }. */
export function parseScript(text) {
  const tokens = tokenize(text.replace(/^﻿/, ''));
  return readBlock(tokens, 0, true).node;
}

function readBlock(tokens, start, top = false) {
  const node = { items: [], bare: [] };
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === '}') {
      if (top) { i += 1; continue; }
      return { node, next: i + 1 };
    }
    if (token === '{') {
      const inner = readBlock(tokens, i + 1);
      node.items.push(['', '=', inner.node]);
      i = inner.next;
      continue;
    }
    if (i + 1 < tokens.length && OPS.has(tokens[i + 1])) {
      const key = unquote(token);
      const op = tokens[i + 1];
      i += 2;
      if (i >= tokens.length) break;
      if (tokens[i] === '{') {
        const inner = readBlock(tokens, i + 1);
        node.items.push([key, op, inner.node]);
        i = inner.next;
      } else {
        node.items.push([key, op, unquote(tokens[i])]);
        i += 1;
      }
      continue;
    }
    node.bare.push(unquote(token));
    i += 1;
  }
  return { node, next: i };
}

const first = (node, key) => {
  for (const [k, , v] of node.items) if (k === key) return v;
  return undefined;
};
const every = (node, key) => node.items.filter(([k]) => k === key).map(([, , v]) => v);

/** A `{ key="..." literal=yes }` wrapper, or a plain string, down to its text. */
function textOf(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  const full = first(value, 'full_names');
  if (full && typeof full === 'object') return textOf(full);
  const key = first(value, 'key');
  return typeof key === 'string' ? key : '';
}

function isLiteral(value) {
  return typeof value === 'object' && first(value, 'literal') === 'yes';
}

/** Read every empire out of a user_empire_designs file. */
export function parseEmpireDesigns(text) {
  const root = parseScript(text);
  const out = [];
  for (const [key, , value] of root.items) {
    if (typeof value !== 'object') continue;
    out.push(readEmpire(key, value));
  }
  return out;
}

export function readEmpire(name, node) {
  const species = first(node, 'species');
  const ruler = first(node, 'ruler');
  const civics = first(node, 'civics');

  const empire = {
    name: textOf(first(node, 'name')) || name,
    nameIsLiteral: isLiteral(first(node, 'name')),
    adjective: textOf(first(node, 'adjective')),
    shipPrefix: textOf(first(node, 'ship_prefix')),
    authority: first(node, 'authority') || '',
    origin: first(node, 'origin') || 'origin_default',
    government: first(node, 'government') || '',
    ethics: every(node, 'ethic').filter((v) => typeof v === 'string'),
    civics: civics ? civics.bare.slice() : [],
    planetName: textOf(first(node, 'planet_name')),
    planetClass: first(node, 'planet_class') || '',
    systemName: textOf(first(node, 'system_name')),
    initializer: first(node, 'initializer') || '',
    shipset: first(node, 'graphical_culture') || '',
    cityset: first(node, 'city_graphical_culture') || '',
    room: first(node, 'room') || '',
    advisorVoice: first(node, 'advisor_voice_type') || '',
    isNomadic: first(node, 'is_nomadic') === 'yes',
    flag: first(node, 'flag') || '',
    speciesClass: '',
    speciesName: '',
    speciesPlural: '',
    speciesAdjective: '',
    portrait: '',
    nameList: '',
    traits: [],
    secondary: null,
    ruler: {
      name: '', gender: '', portrait: '', title: '', titleFemale: '',
      leaderClass: '', traits: [],
    },
  };

  if (species) {
    empire.speciesClass = first(species, 'class') || '';
    empire.portrait = first(species, 'portrait') || '';
    empire.nameList = first(species, 'name_list') || '';
    empire.speciesName = textOf(first(species, 'species_name') ?? first(species, 'name'));
    empire.speciesPlural = textOf(first(species, 'species_plural') ?? first(species, 'plural'));
    empire.speciesAdjective = textOf(first(species, 'species_adjective') ?? first(species, 'adjective'));
    empire.traits = every(species, 'trait').filter((v) => typeof v === 'string');
  }

  const secondary = first(node, 'secondary_species');
  if (secondary) {
    empire.secondary = {
      speciesClass: first(secondary, 'class') || '',
      portrait: first(secondary, 'portrait') || '',
      nameList: first(secondary, 'name_list') || '',
      name: textOf(first(secondary, 'species_name') ?? first(secondary, 'name')),
      plural: textOf(first(secondary, 'species_plural') ?? first(secondary, 'plural')),
      adjective: textOf(first(secondary, 'species_adjective') ?? first(secondary, 'adjective')),
      traits: every(secondary, 'trait').filter((v) => typeof v === 'string'),
    };
  }

  if (ruler) {
    empire.ruler.name = textOf(first(ruler, 'name'));
    empire.ruler.gender = first(ruler, 'gender') || '';
    empire.ruler.portrait = first(ruler, 'portrait') || '';
    empire.ruler.title = textOf(first(ruler, 'ruler_title'));
    empire.ruler.titleFemale = textOf(first(ruler, 'ruler_title_female'));
    empire.ruler.leaderClass = first(ruler, 'leader_class') || '';
    empire.ruler.traits = every(ruler, 'trait').filter((v) => typeof v === 'string');
  }

  return empire;
}

// --------------------------------------------------------------------------
// Writing
// --------------------------------------------------------------------------

const TAB = '\t';

function quote(text) {
  return `"${String(text ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Localisable strings are objects; user-typed ones carry literal=yes. */
function locBlock(indent, key, text, literal = true) {
  const pad = TAB.repeat(indent);
  const inner = TAB.repeat(indent + 1);
  const lines = [`${pad}${key}=`, `${pad}{`, `${inner}key=${quote(text)}`];
  if (literal) lines.push(`${inner}literal=yes`);
  lines.push(`${pad}}`);
  return lines;
}

/**
 * Emit one empire block in the exact dialect the launcher writes, so it can be
 * appended to user_empire_designs_v3.4.txt.
 */
export function serializeEmpire(build) {
  const name = build.name || 'Unnamed Empire';
  const out = [`${quote(name)}=`, '{'];
  const push = (line) => out.push(TAB + line);

  push(`key=${quote(name)}`);
  out.push(...locBlock(1, 'ship_prefix', build.shipPrefix || ''));

  out.push(`${TAB}species=`, `${TAB}{`);
  const s = (line) => out.push(TAB + TAB + line);
  s(`class=${quote(build.speciesClass)}`);
  s(`portrait=${quote(build.portrait || '')}`);
  out.push(...locBlock(2, 'species_name', build.speciesName || name));
  out.push(...locBlock(2, 'species_plural', build.speciesPlural || build.speciesName || name));
  out.push(...locBlock(2, 'species_adjective', build.speciesAdjective || build.speciesName || name));
  s(`name_list=${quote(build.nameList || 'HUMAN1')}`);
  s('gender=not_set');
  for (const trait of build.traits) s(`trait=${quote(trait)}`);
  out.push(`${TAB}}`);

  if (build.secondary) {
    const sec = build.secondary;
    out.push(`${TAB}secondary_species=`, `${TAB}{`);
    const w = (line) => out.push(TAB + TAB + line);
    w(`class=${quote(sec.speciesClass)}`);
    w(`portrait=${quote(sec.portrait || '')}`);
    out.push(...locBlock(2, 'species_name', sec.name));
    out.push(...locBlock(2, 'species_plural', sec.plural));
    out.push(...locBlock(2, 'species_adjective', sec.adjective));
    w(`name_list=${quote(sec.nameList || 'HUMAN1')}`);
    w('gender=not_set');
    for (const trait of sec.traits) w(`trait=${quote(trait)}`);
    out.push(`${TAB}}`);
  }

  out.push(...locBlock(1, 'name', name));
  out.push(...locBlock(1, 'adjective', build.adjective || name));
  push(`authority=${quote(build.authority)}`);
  if (build.flag) push(`flag=${quote(build.flag)}`);
  if (build.government) push(`government=${quote(build.government)}`);
  push(`is_nomadic=${build.isNomadic ? 'yes' : 'no'}`);
  if (build.advisorVoice) push(`advisor_voice_type=${quote(build.advisorVoice)}`);
  out.push(...locBlock(1, 'planet_name', build.planetName || 'Homeworld'));
  push(`planet_class=${quote(build.planetClass || 'pc_continental')}`);
  out.push(...locBlock(1, 'system_name', build.systemName || 'Home'));
  if (build.initializer) push(`initializer=${quote(build.initializer)}`);
  push(`graphical_culture=${quote(build.shipset)}`);
  push(`city_graphical_culture=${quote(build.cityset || build.shipset)}`);

  out.push(`${TAB}empire_flag=`, `${TAB}{`);
  out.push(`${TAB}${TAB}icon=`, `${TAB}${TAB}{`);
  out.push(`${TAB}${TAB}${TAB}category=${quote(build.flagIcon?.category || 'pointy')}`);
  out.push(`${TAB}${TAB}${TAB}file=${quote(build.flagIcon?.file || 'flag_pointy_1.dds')}`);
  out.push(`${TAB}${TAB}}`);
  out.push(`${TAB}${TAB}background=`, `${TAB}${TAB}{`);
  out.push(`${TAB}${TAB}${TAB}category=${quote('backgrounds')}`);
  out.push(`${TAB}${TAB}${TAB}file=${quote(build.flagBackground || '00_solid.dds')}`);
  out.push(`${TAB}${TAB}}`);
  out.push(`${TAB}${TAB}colors=`, `${TAB}${TAB}{`);
  for (const color of (build.flagColors || ['blue', 'black', 'null', 'null'])) {
    out.push(`${TAB}${TAB}${TAB}${quote(color)}`);
  }
  out.push(`${TAB}${TAB}}`);
  out.push(`${TAB}}`);

  out.push(`${TAB}ruler=`, `${TAB}{`);
  const r = (line) => out.push(TAB + TAB + line);
  r(`gender=${build.ruler?.gender || 'not_set'}`);
  out.push(`${TAB}${TAB}name=`, `${TAB}${TAB}{`);
  out.push(`${TAB}${TAB}${TAB}full_names=`, `${TAB}${TAB}${TAB}{`);
  out.push(`${TAB}${TAB}${TAB}${TAB}key=${quote(build.ruler?.name || 'Ruler')}`);
  out.push(`${TAB}${TAB}${TAB}${TAB}literal=yes`);
  out.push(`${TAB}${TAB}${TAB}}`);
  out.push(`${TAB}${TAB}}`);
  r(`portrait=${quote(build.ruler?.portrait || build.portrait || '')}`);
  r('texture=1');
  r('attachment=0');
  r('clothes=1');
  if (build.ruler?.title) out.push(...locBlock(2, 'ruler_title', build.ruler.title));
  if (build.ruler?.titleFemale) out.push(...locBlock(2, 'ruler_title_female', build.ruler.titleFemale));
  for (const trait of (build.ruler?.traits || [])) r(`trait=${quote(trait)}`);
  r(`leader_class=${quote(build.ruler?.leaderClass || 'official')}`);
  out.push(`${TAB}}`);

  push('spawn_as_fallen=no');
  push('ignore_portrait_duplication=yes');
  push(`room=${quote(build.room || 'personality_federation_builders_room')}`);
  push('spawn_enabled=yes');
  for (const ethic of build.ethics) push(`ethic=${quote(ethic)}`);
  out.push(`${TAB}civics=`, `${TAB}{`);
  for (const civic of build.civics) out.push(`${TAB}${TAB}${quote(civic)}`);
  out.push(`${TAB}}`);
  push(`origin=${quote(build.origin)}`);

  out.push('}');
  return out.join('\n');
}
