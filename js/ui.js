// Rendering the planner screen.
//
// Everything re-renders from build state on every change. The card lists are a
// few hundred nodes once unavailable entries are filtered out, which is well
// inside the budget for a full repaint and keeps the state handling honest.

import { arr, num, el, esc } from './util.js';
import { renderText, plainText, iconStyle, modifierLabel, formatModifier } from './loc.js';
import * as rules from './rules.js';

export function nameOf(view, id) {
  const text = view.loc(id);
  return text ? plainText(view, text) : id;
}

function describeEntity(view, entity) {
  const effects = entity.data.description && view.loc(entity.data.description);
  if (effects) return effects;
  return view.loc(`${entity.id}_desc`);
}

function iconNode(view, id, size = 30) {
  const style = iconStyle(view, id, size);
  const node = el('i', { class: 'ico' });
  if (style) node.setAttribute('style', style);
  else node.style.cssText = `width:${size}px;height:${size}px;border-radius:4px;background:#1d2739`;
  return node;
}

/**
 * The actual numbers an entity gives you. Conditional blocks are shown but
 * marked, because a modifier gated on something the designer cannot decide is
 * not the same as one you are getting.
 */
function modifierList(app, entity, { limit = 0 } = {}) {
  const { view, ctx } = app;
  const { active, conditional, tooltips } = rules.entityModifiers(entity, ctx);

  const rows = [
    ...active.map((m) => ({ ...m, state: 'met' })),
    ...conditional,
  ];
  if (!rows.length && !tooltips.length) return null;

  const wrap = el('div', { class: 'mods' });
  const shown = limit ? rows.slice(0, limit) : rows;
  for (const item of shown) {
    const row = el('div', { class: `mod-row${item.state === 'met' ? '' : ' cond'}` },
      el('span', { class: 'mod-name', html: modifierLabel(view, item.key, item.value) }),
      el('span', { class: `mod-val ${item.value > 0 ? 'pos' : 'neg'}` },
        formatModifier(view, item.key, item.value)));
    if (item.state === 'unmet') row.title = 'Only while its condition holds';
    if (item.state === 'unknown') row.title = 'Depends on in-game state this tool cannot check';
    wrap.append(row);
  }
  if (limit && rows.length > limit) {
    wrap.append(el('div', { class: 'mod-more' }, `+${rows.length - limit} more`));
  }
  for (const key of tooltips) {
    const text = view.loc(key);
    if (text) wrap.append(el('div', { class: 'mod-note', html: renderText(view, text) }));
  }
  return wrap;
}

/**
 * The `tags` block. These are the unlocks and special rules the game lists in
 * the tooltip - Ecocentrist's Waste Recycling and Bio-Processing Plant,
 * Industrialist's Thermal Borehole, Hive Mind's ascension restrictions. They
 * are pure prose in the loc data and are not derivable from the modifiers.
 */
function tagList(app, entity, { limit = 0 } = {}) {
  const { view } = app;
  const tags = arr(entity.data.tags?.__list);
  if (!tags.length) return null;

  const wrap = el('div', { class: 'tags' });
  let shown = 0;
  let hidden = 0;
  for (const key of tags) {
    const raw = view.loc(key);
    if (!raw) continue;
    const html = renderText(view, raw).replace(/^(?:<br>|\s)+/, '').trim();
    if (!html) continue;                  // spacers such as NEW_LINE
    if (limit && shown >= limit) { hidden += 1; continue; }
    wrap.append(el('div', { class: 'tag-row', html }));
    shown += 1;
  }
  if (hidden) wrap.append(el('div', { class: 'mod-more' }, `+${hidden} more`));
  return shown ? wrap : null;
}

/** Election rules, succession and the rest of an authority's governance. */
function authorityFacts(view, entity) {
  const data = entity.data;
  const facts = [];
  if (data.election_type && data.election_type !== 'none') {
    const term = num(data.election_term_years, 0);
    facts.push(`${data.election_type} elections${term ? `, ${term} yr term` : ''}`);
  } else if (data.has_heir === 'yes') {
    facts.push('hereditary succession');
  } else if (data.election_type === 'none') {
    facts.push('no elections');
  }
  if (data.re_election_allowed === 'yes') facts.push('re-election allowed');
  if (data.max_election_candidates) facts.push(`${data.max_election_candidates} candidates`);
  if (data.can_have_emergency_elections === 'yes') facts.push('emergency elections');
  if (data.has_agendas === 'yes') facts.push('council agendas');
  if (data.uses_mandates === 'yes') facts.push('mandates');
  if (data.can_reform === 'no') facts.push('cannot be reformed');
  if (data.has_factions === 'no') facts.push('no factions');
  return facts;
}

/**
 * A `text` override is usually a loc key, but mods sometimes put a plain
 * sentence there instead (Gigastructural writes `text = "Disabled for 4.0"`).
 * Show a resolved key, or an unresolved value only when it reads as prose.
 */
function reasonNote(view, reason) {
  if (!reason.text) return null;
  const resolved = view.loc(reason.text);
  if (resolved) return plainText(view, resolved);
  return /\s/.test(reason.text) ? reason.text : null;
}

// Bare triggers read as script otherwise: "Requires is_nomadic = yes".
const BARE_LABEL = {
  'is_nomadic = yes': 'a nomadic empire',
  'is_nomadic = no': 'a settled (non-nomadic) empire',
  'always = yes': 'nothing (always true)',
};

/**
 * Turn one reason into a phrase. Branch groups come from a failing OR/AND at
 * the requirement level, where each branch is a whole alternative - EaC's
 * Imperial authority accepts a legendary-leader origin, OR a fallen-empire
 * origin, OR an authoritarian ethic.
 */
function reasonPhrase(view, reason, depth = 0) {
  const note = reasonNote(view, reason);
  if (note && depth > 0) return note;

  if (reason.branches) {
    // "one of:" already carries the disjunction, so the outermost list reads
    // better comma-separated; nested ones keep the explicit "or".
    const joiner = reason.mode === 'any' ? (depth === 0 ? ', ' : ' or ') : ' and ';
    const parts = reason.branches.map((group) => {
      const inner = group.map((leaf) => reasonPhrase(view, leaf, depth + 1)).filter(Boolean);
      if (!inner.length) return '';
      return inner.length > 1 ? `(${inner.join(' and ')})` : inner[0];
    }).filter(Boolean);
    if (!parts.length) return '';
    const joined = parts.join(joiner);
    return depth > 0 && parts.length > 1 ? `(${joined})` : joined;
  }

  if (reason.literal) return reason.need.map((n) => BARE_LABEL[n] || n).join(', ');
  const list = (ids, sep) => ids.map((id) => nameOf(view, id)).join(sep);
  if (reason.forbid.length) return `not ${list(reason.forbid, ' or ')}`;
  if (!reason.need.length) return '';
  return list(reason.need, reason.mode === 'any' ? ' or ' : ' and ');
}

export function reasonText(view, reason) {
  const note = reasonNote(view, reason);
  if (reason.category === 'disabled') {
    return note ? `Disabled by the mod — ${note}` : 'Disabled by the mod';
  }
  if (note) return note;

  const phrase = reasonPhrase(view, reason);
  if (!phrase) return `Blocked by ${reason.category}`;
  if (reason.forbid.length && !reason.branches) {
    return `Conflicts with ${reason.forbid.map((id) => nameOf(view, id)).join(', ')}`;
  }
  const anyOf = reason.mode === 'any' || reason.branches;
  return `${anyOf ? 'Requires one of: ' : 'Requires '}${phrase}`;
}

// --------------------------------------------------------------------------
// Cards
// --------------------------------------------------------------------------

function card(app, { id, entity, selected, verdict, cost, onPick, extraNote }) {
  const { view } = app;
  const blocked = verdict && !verdict.ok;
  const unverified = verdict && verdict.unknown.length > 0;

  const classes = ['card'];
  if (selected) classes.push('selected');
  if (blocked) classes.push('blocked');
  if (unverified && !blocked) classes.push('unverified');

  const body = el('div', { class: 'body' });
  const title = el('div', { class: 'title' }, el('strong', {}, nameOf(view, id)));
  if (cost !== undefined && cost !== null) {
    title.append(el('span', { class: 'cost' }, cost > 0 ? `${cost} pt${cost === 1 ? '' : 's'}` : `${cost}`));
  }
  body.append(title);

  const desc = describeEntity(view, entity);
  if (desc) {
    body.append(el('div', { class: 'desc', html: renderText(view, desc) }));
  }

  const facts = entity.data.election_type || entity.data.has_heir
    ? authorityFacts(view, entity) : [];
  if (facts.length) body.append(el('div', { class: 'facts' }, facts.join(' · ')));

  const mods = modifierList(app, entity);
  if (mods) body.append(mods);

  const tags = tagList(app, entity);
  if (tags) body.append(tags);

  if (blocked) {
    const why = verdict.reasons.slice(0, 2).map((r) => reasonText(view, r)).join(' · ');
    body.append(el('div', { class: 'why' }, why || 'Requirements not met'));
  }
  if (unverified) {
    body.append(el('div', { class: 'why warn' },
      `Unverified: this tool cannot check ${verdict.unknown.slice(0, 3).join(', ')}`));
  }
  if (extraNote) body.append(el('div', { class: 'src' }, extraNote));
  if (entity.src && entity.src !== 'base') {
    body.append(el('div', { class: 'src' }, `from ${app.sourceName(entity.src)}`));
  }

  const node = el('button', {
    type: 'button',
    class: classes.join(' '),
    title: desc ? plainText(view, desc) : nameOf(view, id),
    onclick: () => {
      if (blocked && !selected) return;
      onPick();
    },
  }, iconNode(view, id), body);

  return node;
}

function sectionShell(app, { key, title, count, searchable }) {
  const head = el('div', { class: 'section-head' },
    el('h2', {}, title),
    count !== undefined ? el('span', { class: 'count' }, count) : null);

  if (searchable) {
    const input = el('input', {
      class: 'search',
      type: 'search',
      placeholder: 'Filter…',
      value: app.search[key] || '',
      oninput: (e) => { app.search[key] = e.target.value; app.rerender({ keepFocus: `search-${key}` }); },
      dataset: { focusId: `search-${key}` },
    });
    head.append(el('span', { class: 'spacer' }), input);
  }

  const grid = el('div', { class: 'card-grid' });
  return { node: el('section', { class: 'section' }, head, grid), grid };
}

function matchesSearch(app, key, view, id) {
  const term = (app.search[key] || '').trim().toLowerCase();
  if (!term) return true;
  return nameOf(view, id).toLowerCase().includes(term) || id.toLowerCase().includes(term);
}

// --------------------------------------------------------------------------
// Sections
// --------------------------------------------------------------------------

function pickableList(app, category, { originsOnly = false } = {}) {
  const { view, ctx } = app;
  const out = [];
  for (const [id, entity] of view.cat[category]) {
    const verdict = rules.evaluate(entity, ctx);
    const selected = category === 'origins'
      ? app.build.origin === id
      : category === 'authorities'
        ? app.build.authority === id
        : app.build.civics.has(id);
    if (!verdict.available && !selected) continue;
    if (app.hideBlocked && !verdict.ok && !selected) continue;
    out.push({ id, entity, verdict, selected });
  }
  out.sort((a, b) => Number(b.selected) - Number(a.selected)
    || Number(a.verdict.ok === false) - Number(b.verdict.ok === false)
    || nameOf(view, a.id).localeCompare(nameOf(view, b.id)));
  return out;
}

// The in-game ethics picker is a wheel, not a list: the non-fanatic ethics sit
// on an inner ring and their fanatic versions directly outside them, with each
// axis's two poles 180 degrees apart. interface/customize_species_editors.gui
// places the vanilla eight at radius 45 and their fanatics at radius 80, in the
// order below. Grouping by `category` rather than hardcoding the eight means
// Ethics and Civics Classic's extra soc/grn axes get their own spokes for free,
// and the standalone ones (gestalt, focused) land in the hub.

const VANILLA_AXIS_ORDER = ['mil', 'xen', 'col', 'spi'];
// Vanilla puts egalitarian and materialist - the `category_opposite` poles - on
// the first half of the wheel; militarist and xenophobe lead on their axes.
const OPPOSITE_LEADS = new Set(['col', 'spi']);

function ethicAxes(view) {
  const groups = new Map();
  for (const entity of view.cat.ethics.values()) {
    if (entity.data.playable === 'no') continue;
    const key = entity.data.category || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entity);
  }

  const axes = [];
  const hub = [];
  for (const [key, list] of groups) {
    const poles = { lead: { normal: null, fanatic: null }, trail: { normal: null, fanatic: null } };
    for (const entity of list) {
      const opposite = entity.data.category_opposite === 'yes';
      const leads = OPPOSITE_LEADS.has(key) ? opposite : !opposite;
      const side = leads ? poles.lead : poles.trail;
      // A fanatic ethic is one with no fanatic variant of its own.
      if (entity.data.fanatic_variant) side.normal = entity;
      else side.fanatic = entity;
    }
    const hasBothPoles = (poles.lead.normal || poles.lead.fanatic)
      && (poles.trail.normal || poles.trail.fanatic);
    if (hasBothPoles) axes.push({ key, ...poles });
    else hub.push(...list);
  }

  axes.sort((a, b) => {
    const ai = VANILLA_AXIS_ORDER.indexOf(a.key);
    const bi = VANILLA_AXIS_ORDER.indexOf(b.key);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.key.localeCompare(b.key);
  });
  hub.sort((a, b) => num(a.data.cost) - num(b.data.cost));
  return { axes, hub };
}

// Gestalt consciousness is the only ethic the engine treats as exclusive, and it
// is hardcoded by id - every civic and authority checks for this exact key. An
// expensive single-member category is NOT automatically exclusive: Ethics and
// Civics Classic's Singular Purpose also costs 3 and sits alone in its own
// category, but nothing stops you pairing it with other ethics.
const EXCLUSIVE_ETHIC = 'ethic_gestalt_consciousness';

/** Why this ethic cannot be picked right now, or null. */
export function ethicBlocker(app, entity) {
  const { view, build, budgets } = app;
  const id = entity.id;
  if (build.ethics.has(id)) return null;

  if (build.ethics.has(EXCLUSIVE_ETHIC) && id !== EXCLUSIVE_ETHIC) {
    return `${nameOf(view, EXCLUSIVE_ETHIC)} excludes every other ethic`;
  }
  if (id === EXCLUSIVE_ETHIC && build.ethics.size) return 'Remove your other ethics first';

  const category = entity.data.category;
  const clash = [...build.ethics]
    .find((other) => view.cat.ethics.get(other)?.data.category === category);
  if (clash) return `Opposed to ${nameOf(view, clash)}`;

  const cost = num(entity.data.cost, 1);
  const left = budgets.ethics.max - budgets.ethics.used;
  if (cost > left) {
    return left > 0 ? `Needs ${cost} points, ${left} left` : 'No ethic points left';
  }
  return null;
}

function ethicButton(app, entity, { x, y, size }) {
  const { view, build } = app;
  const selected = build.ethics.has(entity.id);
  const blocker = ethicBlocker(app, entity);
  const cost = num(entity.data.cost, 1);

  const classes = ['ethic-node'];
  if (selected) classes.push('selected');
  if (blocker) classes.push('blocked');

  const button = el('button', {
    type: 'button',
    class: classes.join(' '),
    style: `left:${x}px;top:${y}px;width:${size}px;height:${size}px`,
    title: `${nameOf(view, entity.id)} — ${cost} point${cost === 1 ? '' : 's'}`
      + (blocker ? `\n${blocker}` : '')
      + `\n\n${plainText(view, describeEntity(view, entity) || '')}`,
    onclick: () => { if (!blocker || selected) app.toggleEthic(entity.id); },
    onmouseenter: () => app.setEthicHover(entity.id),
    onfocus: () => app.setEthicHover(entity.id),
  });

  const style = iconStyle(view, entity.id, size - 8);
  const icon = el('i', { class: 'ethic-ico' });
  if (style) icon.setAttribute('style', style);
  button.append(icon);
  return button;
}

function renderEthics(app) {
  const { view, build, budgets } = app;
  const { axes, hub } = ethicAxes(view);

  const section = el('section', { class: 'section' });
  const head = el('div', { class: 'section-head' },
    el('h2', {}, 'Ethics'),
    el('span', { class: 'count' }, `${budgets.ethics.used} / ${budgets.ethics.max} points`));
  section.append(head);

  const slots = axes.length * 2;
  const innerR = slots > 8 ? 108 : 92;
  const outerR = innerR + 58;
  const nodeSize = slots > 8 ? 34 : 40;
  const box = (outerR + nodeSize / 2 + 6) * 2;
  const centre = box / 2;

  const wheel = el('div', {
    class: 'ethic-wheel',
    style: `width:${box}px;height:${box}px`,
  });

  // Spokes, drawn behind the nodes so each axis reads as one line.
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'ethic-spokes');
  svg.setAttribute('viewBox', `0 0 ${box} ${box}`);
  for (let i = 0; i < axes.length; i += 1) {
    const angle = ((360 / slots) * i - 90) * (Math.PI / 180);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', centre + Math.cos(angle) * outerR);
    line.setAttribute('y1', centre + Math.sin(angle) * outerR);
    line.setAttribute('x2', centre - Math.cos(angle) * outerR);
    line.setAttribute('y2', centre - Math.sin(angle) * outerR);
    svg.append(line);
  }
  const ring = document.createElementNS(svgNS, 'circle');
  ring.setAttribute('cx', centre);
  ring.setAttribute('cy', centre);
  ring.setAttribute('r', innerR);
  ring.setAttribute('class', 'ethic-ring');
  svg.append(ring);
  wheel.append(svg);

  const place = (entity, slot, radius) => {
    if (!entity) return;
    const angle = ((360 / slots) * slot - 90) * (Math.PI / 180);
    const x = centre + Math.cos(angle) * radius - nodeSize / 2;
    const y = centre + Math.sin(angle) * radius - nodeSize / 2;
    wheel.append(ethicButton(app, entity, { x, y, size: nodeSize }));
  };

  axes.forEach((axis, index) => {
    place(axis.lead.normal, index, innerR);
    place(axis.lead.fanatic, index, outerR);
    place(axis.trail.normal, index + axes.length, innerR);
    place(axis.trail.fanatic, index + axes.length, outerR);
  });

  const hubBox = el('div', { class: 'ethic-hub', style: `width:${innerR * 1.35}px;height:${innerR * 1.35}px` });
  if (hub.length) {
    for (const entity of hub) {
      const selected = build.ethics.has(entity.id);
      const blocker = ethicBlocker(app, entity);
      const style = iconStyle(view, entity.id, 30);
      const icon = el('i', { class: 'ethic-ico' });
      if (style) icon.setAttribute('style', style);
      hubBox.append(el('button', {
        type: 'button',
        class: `ethic-hub-node${selected ? ' selected' : ''}${blocker ? ' blocked' : ''}`,
        title: `${nameOf(view, entity.id)} — ${num(entity.data.cost, 1)} points`
          + (blocker ? `\n${blocker}` : ''),
        onclick: () => { if (!blocker || selected) app.toggleEthic(entity.id); },
        onmouseenter: () => app.setEthicHover(entity.id),
      }, icon, el('span', {}, nameOf(view, entity.id))));
    }
  } else {
    hubBox.append(el('span', { class: 'ethic-hub-empty' },
      `${budgets.ethics.max - budgets.ethics.used} left`));
  }
  wheel.append(hubBox);

  const detail = el('div', { class: 'ethic-detail' });
  fillEthicDetail(app, detail);

  section.append(el('div', { class: 'ethic-layout' }, wheel, detail));
  return section;
}

/** The panel beside the wheel: the hovered ethic, else everything chosen. */
export function fillEthicDetail(app, detail) {
  const { view, build, budgets } = app;
  const hovered = app.ethicHover && view.cat.ethics.get(app.ethicHover);
  const shown = hovered
    ? [hovered]
    : [...build.ethics].map((id) => view.cat.ethics.get(id)).filter(Boolean);

  const nodes = [];
  if (!shown.length) {
    nodes.push(el('p', { class: 'hint' },
      `Pick up to ${budgets.ethics.max} points. A fanatic ethic costs 2 and rules out its opposite; `
      + 'the hub choices take every point you have.'));
  }
  for (const entity of shown) {
    const blocker = ethicBlocker(app, entity);
    const chosen = build.ethics.has(entity.id);
    const box = el('div', { class: `ethic-detail-card${chosen ? ' chosen' : ''}` });
    box.append(el('div', { class: 'title' },
      el('strong', {}, nameOf(view, entity.id)),
      el('span', { class: 'cost' }, `${num(entity.data.cost, 1)} pt`)));
    const desc = describeEntity(view, entity);
    if (desc) box.append(el('div', { class: 'desc', html: renderText(view, desc) }));
    const mods = modifierList(app, entity);
    if (mods) box.append(mods);
    const tags = tagList(app, entity);
    if (tags) box.append(tags);
    if (!mods && !tags) {
      // Ethics and Civics Classic leaves ethic_focused ("Singular Purpose") in
      // the data with no modifiers and nothing referencing it, so it silently
      // eats 3 of your points. Say so instead of leaving the panel blank.
      box.append(el('div', { class: 'mod-note warn-note' },
        `No modifiers — costs ${num(entity.data.cost, 1)} points and changes nothing.`));
    }
    if (blocker) box.append(el('div', { class: 'why' }, blocker));
    if (entity.src !== 'base') box.append(el('div', { class: 'src' }, `from ${app.sourceName(entity.src)}`));
    nodes.push(box);
  }
  detail.replaceChildren(...nodes);
}

function renderChoice(app, { key, title, category, selectedId, onPick, countLabel }) {
  const { view } = app;
  const { node, grid } = sectionShell(app, {
    key, title, count: countLabel, searchable: true,
  });
  const items = pickableList(app, category).filter((x) => matchesSearch(app, key, view, x.id));
  for (const item of items) {
    grid.append(card(app, {
      id: item.id,
      entity: item.entity,
      selected: item.id === selectedId,
      verdict: item.verdict,
      onPick: () => onPick(item.id),
    }));
  }
  if (!items.length) grid.append(el('p', { class: 'empty' }, 'Nothing available with the current picks.'));
  return node;
}

function renderCivics(app) {
  const { view, build, budgets } = app;
  const { node, grid } = sectionShell(app, {
    key: 'civics', title: 'Civics',
    count: `${budgets.civics.used} / ${budgets.civics.max}`,
    searchable: true,
  });

  const items = pickableList(app, 'civics')
    .filter((x) => matchesSearch(app, 'civics', view, x.id));

  const atLimit = budgets.civics.used >= budgets.civics.max;
  for (const item of items) {
    const selected = build.civics.has(item.id);
    const verdict = (!selected && atLimit && item.verdict.ok)
      ? { ...item.verdict, ok: false, reasons: [{ category: 'civics', text: null, need: [], forbid: [], mode: 'all' }] }
      : item.verdict;
    const node2 = card(app, {
      id: item.id, entity: item.entity, selected, verdict,
      onPick: () => app.toggleCivic(item.id),
    });
    if (!selected && atLimit && item.verdict.ok) {
      const why = node2.querySelector('.why');
      if (why) why.textContent = 'No civic slots left';
    }
    grid.append(node2);
  }
  if (!items.length) grid.append(el('p', { class: 'empty' }, 'No civics available for this government.'));
  return node;
}

function renderSpeciesTraits(app) {
  const { view, build, budgets, ctx } = app;
  const forced = rules.forcedTraits(view, build);

  const { node, grid } = sectionShell(app, {
    key: 'traits',
    title: 'Species traits',
    count: `${budgets.traitPoints.used} / ${budgets.traitPoints.max} points · ${budgets.traitPicks.used} / ${budgets.traitPicks.max} picks`,
    searchable: true,
  });

  if (forced.locked.size || forced.soft.size) {
    const chips = el('div', { class: 'card-grid' });
    for (const [id, from] of [...forced.locked, ...forced.soft]) {
      const entity = view.cat.species_traits.get(id);
      if (!entity) continue;
      chips.append(card(app, {
        id, entity, selected: true, verdict: { ok: true, unknown: [], reasons: [] },
        cost: 0,
        extraNote: `granted by ${from}${forced.soft.has(id) ? ' (removable)' : ' (locked)'}`,
        onPick: () => {},
      }));
    }
    if (chips.children.length) {
      node.append(el('p', { class: 'hint' }, 'Granted automatically:'), chips);
    }
  }

  const items = [];
  for (const [id, entity] of view.cat.species_traits) {
    if (forced.locked.has(id)) continue;
    if (!rules.traitIsSelectable(entity)) continue;
    if (!matchesSearch(app, 'traits', view, id)) continue;
    const status = rules.traitStatus(entity, ctx);
    const selected = build.traits.has(id);
    if (!status.available && !selected) continue;
    if (app.hideBlocked && !status.ok && !selected) continue;
    items.push({ id, entity, status, selected, cost: rules.traitCost(entity) });
  }

  items.sort((a, b) => Number(b.selected) - Number(a.selected)
    || Number(!a.status.ok) - Number(!b.status.ok)
    || b.cost - a.cost
    || nameOf(view, a.id).localeCompare(nameOf(view, b.id)));

  const pickRoom = budgets.traitPicks.used < budgets.traitPicks.max;
  for (const item of items) {
    let verdict = item.status;
    if (!item.selected && verdict.ok) {
      if (!pickRoom) {
        verdict = { ...verdict, ok: false, reasons: [{ category: 'traits', text: null, need: [], forbid: [], mode: 'all' }] };
      } else if (item.cost > 0 && budgets.traitPoints.used + item.cost > budgets.traitPoints.max) {
        verdict = { ...verdict, ok: false, reasons: [{ category: 'traits', text: null, need: [], forbid: [], mode: 'all' }] };
      }
    }
    const node2 = card(app, {
      id: item.id, entity: item.entity, selected: item.selected,
      verdict, cost: item.cost,
      onPick: () => app.toggleTrait(item.id),
    });
    if (!item.selected && item.status.ok && !verdict.ok) {
      const why = node2.querySelector('.why');
      if (why) why.textContent = pickRoom ? 'Not enough trait points' : 'No trait picks left';
    }
    grid.append(node2);
  }

  if (!items.length) grid.append(el('p', { class: 'empty' }, 'No traits available for this archetype.'));
  return node;
}

function renderRulerTraits(app) {
  const { view, build, ctx } = app;
  const { node, grid } = sectionShell(app, {
    key: 'ruler', title: 'Ruler traits',
    count: `${build.rulerTraits.size} selected`,
    searchable: true,
  });

  node.querySelector('.section-head').append(
    el('span', { class: 'count' }, 'only traits the designer offers at creation'),
  );

  const items = [];
  for (const [id, entity] of view.cat.leader_traits) {
    if (entity.data.starting_ruler_trait !== 'yes') continue;
    if (!matchesSearch(app, 'ruler', view, id)) continue;
    const forbidden = arr(entity.data.forbidden_origins?.__list);
    const allowed = arr(entity.data.allowed_origins?.__list);
    const reasons = [];
    if (forbidden.includes(build.origin)) {
      reasons.push({ category: 'origin', text: null, need: [], forbid: [build.origin], mode: 'none' });
    }
    if (allowed.length && !allowed.includes(build.origin)) {
      reasons.push({ category: 'origin', text: null, need: allowed, forbid: [], mode: 'any' });
    }
    const classes = arr(entity.data.leader_class?.__list);
    items.push({
      id, entity, classes,
      verdict: { ok: reasons.length === 0, reasons, unknown: [] },
      selected: build.rulerTraits.has(id),
    });
  }
  items.sort((a, b) => Number(b.selected) - Number(a.selected)
    || nameOf(view, a.id).localeCompare(nameOf(view, b.id)));

  for (const item of items) {
    grid.append(card(app, {
      id: item.id, entity: item.entity, selected: item.selected,
      verdict: item.verdict,
      cost: num(item.entity.data.cost, 1),
      extraNote: item.classes.length ? `class: ${item.classes.join(', ')}` : null,
      onPick: () => app.toggleRulerTrait(item.id),
    }));
  }
  if (!items.length) grid.append(el('p', { class: 'empty' }, 'No starting ruler traits available.'));
  return node;
}

// --------------------------------------------------------------------------
// Field sections
// --------------------------------------------------------------------------

function textField(app, label, key, { placeholder = '', target = null } = {}) {
  const holder = target || app.build;
  return el('div', { class: 'field' },
    el('label', { for: `f-${key}` }, label),
    el('input', {
      id: `f-${key}`,
      type: 'text',
      value: holder[key] ?? '',
      placeholder,
      dataset: { focusId: `f-${key}` },
      oninput: (e) => { holder[key] = e.target.value; app.scheduleLightRefresh(); },
    }));
}

function selectField(app, label, key, options, onChange, { target = null } = {}) {
  const holder = target || app.build;
  const select = el('select', {
    id: `f-${key}`,
    dataset: { focusId: `f-${key}` },
    onchange: (e) => onChange(e.target.value),
  });
  for (const option of options) {
    const node = el('option', { value: option.value }, option.label);
    if (option.value === holder[key]) node.selected = true;
    select.append(node);
  }
  return el('div', { class: 'field' }, el('label', { for: `f-${key}` }, label), select);
}

function renderIdentity(app) {
  const { view, build } = app;
  const section = el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', {}, 'Empire & species')));

  const speciesClasses = [...view.cat.species_classes.values()]
    .filter((entity) => entity.data.archetype)
    .filter((entity) => rules.evaluate(entity, app.ctx).available || entity.id === build.speciesClass)
    .sort((a, b) => nameOf(view, a.id).localeCompare(nameOf(view, b.id)));

  // No `selectable` block means always selectable; the gated ones only check
  // DLC ownership.
  const shipsets = [...view.cat.graphical_culture.values()]
    .filter((entity) => {
      if (!entity.data.selectable) return true;
      return rules.evalTrigger(entity.data.selectable, app.ctx, new Set());
    })
    .sort((a, b) => shipsetLabel(view, a).localeCompare(shipsetLabel(view, b)));

  const nameLists = [...view.cat.name_lists.keys()].sort();
  const portraits = portraitOptions(view, build.speciesClass);
  // A select falls back to its first option, so keep the model in step or the
  // export would carry an empty portrait while the screen shows one.
  if (portraits.length && !portraits.includes(build.portrait)) {
    build.portrait = portraits.includes('human') ? 'human' : portraits[0];
  }

  const grid = el('div', { class: 'field-grid' },
    textField(app, 'Empire name', 'name', { placeholder: 'United Nations of Earth' }),
    textField(app, 'Empire adjective', 'adjective', { placeholder: 'Human' }),
    textField(app, 'Ship prefix', 'shipPrefix', { placeholder: 'UNS' }),
    selectField(app, 'Species class', 'speciesClass',
      speciesClasses.map((entity) => ({ value: entity.id, label: `${nameOf(view, entity.id)} — ${entity.data.archetype}` })),
      (value) => app.setSpeciesClass(value)),
    textField(app, 'Species name', 'speciesName', { placeholder: 'Human' }),
    textField(app, 'Species plural', 'speciesPlural', { placeholder: 'Humans' }),
    textField(app, 'Species adjective', 'speciesAdjective', { placeholder: 'Human' }),
    selectField(app, 'Ship appearance', 'shipset',
      shipsets.map((entity) => ({ value: entity.id, label: shipsetLabel(view, entity) })),
      (value) => app.set('shipset', value)),
    selectField(app, 'Name list', 'nameList',
      nameLists.map((id) => ({ value: id, label: nameOf(view, id) })),
      (value) => app.set('nameList', value)),
    selectField(app, 'Portrait', 'portrait',
      portraits.map((id) => ({ value: id, label: id })),
      (value) => app.set('portrait', value)),
  );

  const archetype = rules.archetypeOf(view, build.speciesClass);
  const isRobotic = view.cat.species_archetypes.get(archetype)?.data.robotic === 'yes';
  grid.append(el('div', { class: 'field' },
    el('label', {}, 'Archetype'),
    el('input', { type: 'text', value: `${archetype} — ${isRobotic ? 'mechanical' : 'biological'}`, readonly: true }),
    el('span', { class: 'forced' }, `${app.budgets.traitPoints.max} trait points, ${app.budgets.traitPicks.max} picks`)));

  section.append(grid);
  return section;
}

function shipsetLabel(view, entity) {
  const name = nameOf(view, entity.id);
  const bio = entity.id.startsWith('biogenesis') || entity.id === 'wilderness_01';
  const machine = entity.id === 'synthetics_01' || entity.id === 'cybernetics_01';
  const kind = bio ? ' (biological)' : machine ? ' (mechanical)' : '';
  return `${name === entity.id ? prettyId(entity.id) : name}${kind}`;
}

function prettyId(id) {
  return id.replace(/_0?1$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function portraitOptions(view, speciesClass) {
  // Prefer sets declared for this class. Only fall back to the unclassified
  // sets when a class has none of its own, otherwise every class would offer
  // every portrait in the game.
  const matched = new Set();
  const unclassified = new Set();
  for (const entity of view.cat.portrait_sets.values()) {
    const target = entity.data.species_class ? matched : unclassified;
    if (entity.data.species_class && entity.data.species_class !== speciesClass) continue;
    for (const id of arr(entity.data.portraits)) target.add(id);
  }
  const chosen = matched.size ? matched : unclassified;
  return [...chosen].sort();
}

/**
 * The second species Necrophage, Syncretic Evolution, Driven Assimilator and
 * friends bring with them. Only rendered when something in the build asks for
 * one; it gets its own class, names and trait budget.
 */
function renderSecondarySpecies(app) {
  const { view, build } = app;
  const info = rules.secondarySpecies(view, build);
  const section = el('section', { class: 'section' });

  if (!info.required) {
    section.append(el('div', { class: 'section-head' }, el('h2', {}, 'Secondary species')),
      el('p', { class: 'hint' },
        'Nothing in this build adds a second species. Origins like Necrophage or '
        + 'Syncretic Evolution, and civics like Driven Assimilator or Rogue Servitor, do.'));
    return section;
  }

  const heading = info.title ? plainText(view, view.loc(info.title)) || 'Secondary species'
    : 'Secondary species';
  const from = info.sources.map((id) => nameOf(view, id)).join(', ');

  const ctx = app.ctx;
  const classes = [...view.cat.species_classes.values()]
    .filter((entity) => rules.secondaryClassAllowed(view, entity, ctx))
    .filter((entity) => rules.evaluate(entity, ctx).available || entity.id === build.secondary.speciesClass)
    .sort((a, b) => nameOf(view, a.id).localeCompare(nameOf(view, b.id)));

  if (!build.secondary.speciesClass && classes.length) {
    build.secondary.speciesClass = classes[0].id;
  }

  const budget = rules.speciesTraitBudget(
    view, build.secondary.speciesClass, build.secondary.traits, app.modifiers.totals,
  );

  section.append(el('div', { class: 'section-head' },
    el('h2', {}, heading),
    el('span', { class: 'count' },
      `${budget.points.used} / ${budget.points.max} points · ${budget.picks.used} / ${budget.picks.max} picks`),
    el('span', { class: 'count' }, `added by ${from}`)));

  const portraits = portraitOptions(view, build.secondary.speciesClass);
  if (portraits.length && !portraits.includes(build.secondary.portrait)) {
    build.secondary.portrait = portraits[0];
  }
  const nameLists = [...view.cat.name_lists.keys()].sort();
  if (nameLists.length && !nameLists.includes(build.secondary.nameList)) {
    build.secondary.nameList = nameLists.includes('HUMAN1') ? 'HUMAN1' : nameLists[0];
  }

  section.append(el('div', { class: 'field-grid' },
    selectField(app, 'Species class', 'speciesClass',
      classes.map((entity) => ({ value: entity.id, label: `${nameOf(view, entity.id)} — ${entity.data.archetype}` })),
      (value) => app.setSecondarySpeciesClass(value),
      { target: build.secondary }),
    textField(app, 'Species name', 'name', { placeholder: 'Prepatent', target: build.secondary }),
    textField(app, 'Species plural', 'plural', { placeholder: 'Prepatents', target: build.secondary }),
    textField(app, 'Species adjective', 'adjective', { placeholder: 'Prepatent', target: build.secondary }),
    selectField(app, 'Name list', 'nameList',
      nameLists.map((id) => ({ value: id, label: nameOf(view, id) })),
      (value) => { build.secondary.nameList = value; app.rerender(); },
      { target: build.secondary }),
    selectField(app, 'Portrait', 'portrait',
      portraits.map((id) => ({ value: id, label: id })),
      (value) => { build.secondary.portrait = value; app.rerender(); },
      { target: build.secondary })));

  if (info.forced.size) {
    const chips = el('div', { class: 'card-grid' });
    for (const [id, source] of info.forced) {
      const entity = view.cat.species_traits.get(id);
      if (!entity) continue;
      chips.append(card(app, {
        id, entity, selected: true, cost: 0,
        verdict: { ok: true, unknown: [], reasons: [] },
        extraNote: `granted by ${nameOf(view, source)} (locked)`,
        onPick: () => {},
      }));
    }
    if (chips.children.length) {
      section.append(el('p', { class: 'hint' }, 'Granted automatically:'), chips);
    }
  }

  // Traits are gated on the secondary species own class, not the founder's.
  const secondaryCtx = {
    ...ctx,
    speciesClass: build.secondary.speciesClass,
    archetype: budget.archetype,
    traits: build.secondary.traits,
  };
  const grid = el('div', { class: 'card-grid' });
  const items = [];
  for (const [id, entity] of view.cat.species_traits) {
    if (info.forced.has(id)) continue;
    if (!rules.traitIsSelectable(entity)) continue;
    if (!matchesSearch(app, 'secondary', view, id)) continue;
    const status = rules.traitStatus(entity, secondaryCtx);
    const selected = build.secondary.traits.has(id);
    if (!status.available && !selected) continue;
    if (app.hideBlocked && !status.ok && !selected) continue;
    items.push({ id, entity, status, selected, cost: rules.traitCost(entity) });
  }
  items.sort((a, b) => Number(b.selected) - Number(a.selected)
    || Number(!a.status.ok) - Number(!b.status.ok)
    || b.cost - a.cost
    || nameOf(view, a.id).localeCompare(nameOf(view, b.id)));

  const pickRoom = budget.picks.used < budget.picks.max;
  for (const item of items) {
    let verdict = item.status;
    if (!item.selected && verdict.ok
        && (!pickRoom || (item.cost > 0 && budget.points.used + item.cost > budget.points.max))) {
      verdict = { ...verdict, ok: false, reasons: [] };
    }
    const node = card(app, {
      id: item.id, entity: item.entity, selected: item.selected,
      verdict, cost: item.cost,
      onPick: () => app.toggleSecondaryTrait(item.id),
    });
    if (!item.selected && item.status.ok && !verdict.ok) {
      const why = node.querySelector('.why');
      const text = pickRoom ? 'Not enough trait points' : 'No trait picks left';
      if (why) why.textContent = text;
      else node.querySelector('.body').append(el('div', { class: 'why' }, text));
    }
    grid.append(node);
  }
  section.append(grid);
  return section;
}

function renderHomeworld(app) {
  const { view, build } = app;
  const origin = view.cat.origins.get(build.origin);
  const forcedColony = origin?.data.starting_colony;
  const forcedPreference = origin?.data.habitability_preference;

  const planets = [...view.cat.planet_classes.values()]
    .filter((entity) => entity.data.climate && entity.data.colonizable === 'yes')
    .sort((a, b) => nameOf(view, a.id).localeCompare(nameOf(view, b.id)));

  const section = el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', {}, 'Homeworld')));

  const grid = el('div', { class: 'field-grid' },
    selectField(app, 'Planet class', 'planetClass',
      planets.map((entity) => ({
        value: entity.id,
        label: `${nameOf(view, entity.id)} (${entity.data.climate})`,
      })),
      (value) => app.set('planetClass', value)),
    textField(app, 'Homeworld name', 'planetName', { placeholder: 'Earth' }),
    textField(app, 'System name', 'systemName', { placeholder: 'Sol' }),
    selectField(app, 'Advisor voice', 'advisorVoice',
      [{ value: '', label: '(default)' }, ...view.db.options.advisor_voices.map((id) => ({ value: id, label: nameOf(view, id) }))],
      (value) => app.set('advisorVoice', value)),
    selectField(app, 'Room', 'room',
      view.db.options.rooms.map((id) => ({ value: id, label: nameOf(view, id) })),
      (value) => app.set('room', value)),
  );

  if (forcedColony) {
    grid.firstChild.append(el('span', { class: 'forced' },
      `${nameOf(view, build.origin)} starts on ${nameOf(view, forcedColony)}`));
  } else if (forcedPreference) {
    grid.firstChild.append(el('span', { class: 'forced' },
      `${nameOf(view, build.origin)} prefers ${nameOf(view, forcedPreference)}`));
  }

  section.append(grid);
  return section;
}

function renderRuler(app) {
  const { view, build } = app;
  const section = el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', {}, 'Ruler')));

  const governments = rules.matchingGovernments(view, app.ctx);
  const authority = view.cat.authorities.get(build.authority);
  const best = governments[0];

  const grid = el('div', { class: 'field-grid' },
    textField(app, 'Ruler name', 'name', { placeholder: 'Ada Vasil', target: build.ruler }),
    selectField(app, 'Gender', 'gender',
      [['not_set', 'Any'], ['male', 'Male'], ['female', 'Female'], ['indeterminable', 'Indeterminable']]
        .map(([value, label]) => ({ value, label })),
      (value) => { build.ruler.gender = value; app.rerender(); },
      { target: build.ruler }),
    textField(app, 'Ruler title', 'title', { placeholder: rulerTitleHint(view, best), target: build.ruler }),
    selectField(app, 'Leader class', 'leaderClass',
      ['official', 'commander', 'scientist'].map((value) => ({ value, label: value })),
      (value) => { build.ruler.leaderClass = value; app.rerender(); },
      { target: build.ruler }),
  );
  section.append(grid);

  const govBox = el('div', { class: 'field-grid' });
  const govField = el('div', { class: 'field' },
    el('label', {}, 'Government type'),
    el('input', {
      type: 'text',
      readonly: true,
      value: best ? nameOf(view, best.id) : '(none available)',
    }),
    el('span', { class: 'forced' },
      governments.length > 1
        ? `${governments.length} match; the game picks the highest-weighted`
        : 'derived from authority, ethics and civics'));
  govBox.append(govField);

  if (authority?.data.has_heir === 'yes') {
    govBox.append(el('div', { class: 'field' },
      el('label', {}, 'Succession'),
      el('input', { type: 'text', readonly: true, value: 'Heir (hereditary)' })));
  } else if (authority?.data.election_type) {
    govBox.append(el('div', { class: 'field' },
      el('label', {}, 'Elections'),
      el('input', {
        type: 'text',
        readonly: true,
        value: `${authority.data.election_type}, ${num(authority.data.election_term_years, 0)} yr term`,
      })));
  }
  section.append(govBox);

  if (governments.length > 1) {
    const list = governments.slice(0, 8)
      .map((g) => `${nameOf(view, g.id)} (${g.weight})`).join(' · ');
    section.append(el('p', { class: 'hint' }, `Also matching: ${list}`));
  }

  return section;
}

function rulerTitleHint(view, best) {
  if (!best) return 'Chancellor';
  const title = best.entity.data.ruler_title;
  return title ? nameOf(view, title) : 'Chancellor';
}

// --------------------------------------------------------------------------
// Top-level renders
// --------------------------------------------------------------------------

export const SECTIONS = [
  ['identity', 'Species'],
  ['ethics', 'Ethics'],
  ['authority', 'Authority'],
  ['origin', 'Origin'],
  ['civics', 'Civics'],
  ['traits', 'Traits'],
  ['secondary', 'Secondary'],
  ['homeworld', 'Homeworld'],
  ['ruler', 'Ruler'],
  ['rulerTraits', 'Ruler traits'],
];

export function renderMain(app) {
  const main = document.getElementById('main');
  const built = [
    ['identity', renderIdentity(app)],
    ['ethics', renderEthics(app)],
    ['authority', renderChoice(app, {
      key: 'authority', title: 'Authority', category: 'authorities',
      selectedId: app.build.authority,
      onPick: (id) => app.set('authority', id),
    })],
    ['origin', renderChoice(app, {
      key: 'origin', title: 'Origin', category: 'origins',
      selectedId: app.build.origin,
      onPick: (id) => app.set('origin', id),
    })],
    ['civics', renderCivics(app)],
    ['traits', renderSpeciesTraits(app)],
    ['secondary', renderSecondarySpecies(app)],
    ['homeworld', renderHomeworld(app)],
    ['ruler', renderRuler(app)],
    ['rulerTraits', renderRulerTraits(app)],
  ];
  for (const [key, node] of built) node.id = `sec-${key}`;
  main.replaceChildren(...built.map(([, node]) => node));
}

/** Jump-to-section pills, with a dot on any section holding a problem. */
export function renderNav(app) {
  const holder = document.getElementById('nav-pills');
  const trouble = new Set();
  for (const issue of app.issues()) {
    if (issue.section) trouble.add(issue.section);
  }
  holder.replaceChildren(...SECTIONS.map(([key, label]) => el('button', {
    type: 'button',
    class: `nav-pill${trouble.has(key) ? ' has-issue' : ''}`,
    onclick: () => {
      const target = document.getElementById(`sec-${key}`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  }, label)));

  const checkbox = document.getElementById('chk-hide-blocked');
  if (checkbox.checked !== app.hideBlocked) checkbox.checked = app.hideBlocked;
}

export function renderBudgets(app) {
  const holder = document.getElementById('budgets');
  const chip = (label, budget) => {
    const classes = ['budget'];
    if (budget.used > budget.max) classes.push('over');
    else if (budget.used === budget.max) classes.push('full');
    return el('div', { class: classes.join(' ') },
      el('span', { class: 'label' }, label),
      el('b', {}, `${round(budget.used)}/${round(budget.max)}`));
  };
  holder.replaceChildren(
    chip('Ethics', app.budgets.ethics),
    chip('Civics', app.budgets.civics),
    chip('Trait pts', app.budgets.traitPoints),
    chip('Trait picks', app.budgets.traitPicks),
  );
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/** A compact picture of the build, so you never scroll to see what you picked. */
function renderPicks(app) {
  const { view, build } = app;
  const box = el('div', { class: 'picks' });

  const chip = (id, onRemove) => {
    const node = el('button', {
      type: 'button',
      class: `pick${onRemove ? '' : ' fixed'}`,
      title: onRemove ? `${nameOf(view, id)} - click to remove` : nameOf(view, id),
      onclick: () => { if (onRemove) onRemove(); },
    });
    const style = iconStyle(view, id, 18);
    const icon = el('i', { class: 'ethic-ico' });
    if (style) icon.setAttribute('style', style);
    node.append(icon, el('span', {}, nameOf(view, id)));
    return node;
  };

  const row = (label, ids, onRemove) => {
    if (!ids.length) return;
    const line = el('div', { class: 'pick-row' }, el('span', { class: 'pick-label' }, label));
    for (const id of ids) line.append(chip(id, onRemove && (() => onRemove(id))));
    box.append(line);
  };

  row('Ethics', [...build.ethics], (id) => app.toggleEthic(id));
  row('Authority', build.authority ? [build.authority] : []);
  row('Origin', build.origin ? [build.origin] : []);
  row('Civics', [...build.civics], (id) => app.toggleCivic(id));
  row('Traits', [...build.traits], (id) => app.toggleTrait(id));
  row('Ruler', [...build.rulerTraits], (id) => app.toggleRulerTrait(id));

  if (!box.children.length) {
    box.append(el('p', { class: 'hint' }, 'Nothing picked yet.'));
  }
  return box;
}

export function renderStats(app) {
  const { view } = app;
  const holder = document.getElementById('stats');
  const nodes = [];

  nodes.push(el('h2', {}, 'Your empire'));
  nodes.push(renderPicks(app));

  const issues = app.issues();
  nodes.push(el('h2', { style: 'margin-top:18px' }, 'Validation'));
  if (!issues.length) {
    nodes.push(el('p', { class: 'hint' }, 'Every pick satisfies its requirements.'));
  } else {
    const list = el('div', { class: 'issue-list' });
    for (const issue of issues) {
      list.append(el('div', { class: `issue${issue.kind === 'warn' ? ' warn' : ''}` },
        el('b', {}, issue.label), ' — ', issue.text));
    }
    nodes.push(list);
  }

  const { totals, contributions } = app.modifiers;
  nodes.push(el('h2', { style: 'margin-top:18px' }, `Empire modifiers (${totals.size})`));

  if (!totals.size) {
    nodes.push(el('p', { class: 'hint' }, 'Pick ethics, civics or traits to see their combined effect.'));
  } else {
    const byKey = new Map();
    for (const item of contributions) {
      if (!byKey.has(item.key)) byKey.set(item.key, []);
      byKey.get(item.key).push(item);
    }
    const group = el('div', { class: 'stat-group' });
    const sorted = [...totals.entries()]
      .sort((a, b) => modifierLabelText(view, a[0]).localeCompare(modifierLabelText(view, b[0])));
    for (const [key, value] of sorted) {
      if (!value) continue;
      const from = byKey.get(key) || [];
      const row = el('div', { class: 'stat-row' },
        el('span', { class: 'lbl', html: modifierLabel(view, key) }),
        el('span', { class: `n ${value > 0 ? 'pos' : 'neg'}` }, formatModifier(view, key, value)));
      row.title = from.map((f) => `${nameOf(view, f.fromId)} (${f.fromKind}): ${formatModifier(view, key, f.value)}`).join('\n');
      group.append(row);
    }
    nodes.push(group);
  }

  holder.replaceChildren(...nodes);
}

function modifierLabelText(view, key) {
  const holder = document.createElement('div');
  holder.innerHTML = modifierLabel(view, key);
  return holder.textContent;
}

export function renderRail(app) {
  const modList = document.getElementById('mod-list');
  const dlcList = document.getElementById('dlc-list');
  const { db } = app;

  modList.replaceChildren(...db.meta.sources
    .filter((source) => source.id !== 'base')
    .map((source) => {
      const hasContent = app.contentSources.has(source.id);
      const note = hasContent
        ? contentSummary(app, source.id)
        : 'no empire-creation content';
      const input = el('input', {
        type: 'checkbox',
        onchange: () => app.toggleSource(source.id),
      });
      input.checked = app.enabledSources.has(source.id);
      input.disabled = !hasContent;
      return el('label', { class: `toggle${hasContent ? '' : ' inert'}` },
        input,
        el('span', {},
          el('span', { class: 'name' }, source.name),
          el('span', { class: 'note' }, note)));
    }));

  dlcList.replaceChildren(...db.options.dlcs.map((dlc) => {
    const input = el('input', {
      type: 'checkbox',
      onchange: () => app.toggleDlc(dlc.name),
    });
    input.checked = app.build.dlcs.has(dlc.name);
    return el('label', { class: 'toggle' }, input,
      el('span', {}, el('span', { class: 'name' }, dlc.name)));
  }));
}

const BUDGET_DEFINES = new Set(['ETHOS_MAX_POINTS', 'GOVERNMENT_CIVIC_POINTS_BASE']);

function contentSummary(app, sourceId) {
  const counts = app.sourceCounts.get(sourceId);
  if (!counts) return 'affects empire creation';
  const parts = [];
  const label = {
    ethics: 'ethics', authorities: 'authorities', civics: 'civics',
    origins: 'origins', species_traits: 'traits', leader_traits: 'leader traits',
    governments: 'governments',
  };
  for (const [key, text] of Object.entries(label)) {
    if (counts[key]) parts.push(`${counts[key]} ${text}`);
  }

  if (counts.defines) {
    const entry = app.db.defines.find((d) => d.src === sourceId);
    const touchesBudget = entry && Object.keys(entry.values).some((k) => BUDGET_DEFINES.has(k));
    parts.push(touchesBudget
      ? 'changes point budgets'
      // Unlimited Leader Trait Options only raises how many traits a leader is
      // offered on level-up, which the empire designer never sees.
      : 'affects in-game levelling only');
  }
  return parts.length ? parts.join(', ') : 'affects empire creation';
}
