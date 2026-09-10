// Reverse effect search: "what in my playset gives research speed?"
//
// The planner can already tell you what one civic does. This asks the question
// backwards, across every ethic, authority, civic, origin and trait at once,
// ranked by how much each one actually gives.

import { arr, el, debounce } from './util.js';
import { modifierLabel, formatModifier, plainText, iconStyle, modifierTone } from './loc.js';
import { nameOf, reasonText, ethicBlocker } from './ui.js';
import * as rules from './rules.js';

const SEARCHED = [
  ['ethics', 'Ethic'],
  ['authorities', 'Authority'],
  ['civics', 'Civic'],
  ['origins', 'Origin'],
  ['species_traits', 'Species trait'],
  ['leader_traits', 'Ruler trait'],
];

let cache = null;   // { token, index }

/**
 * modifierKey -> { label, providers: [{category, id, value, conditional}] }
 *
 * Built from the merged view, so it follows the mod toggles like everything
 * else. Rebuilt only when the enabled set changes.
 */
export function buildIndex(app) {
  const token = [...app.enabledSources].sort().join('|');
  if (cache && cache.token === token) return cache.index;

  const { view } = app;
  // A neutral context: this is a catalogue of what exists, not of what the
  // current build happens to unlock.
  const ctx = rules.makeContext(view, app.build);
  const index = new Map();

  for (const [category, label] of SEARCHED) {
    for (const [id, entity] of view.cat[category]) {
      if (category === 'leader_traits' && entity.data.starting_ruler_trait !== 'yes') continue;
      const { active, conditional } = rules.entityModifiers(entity, ctx);
      const rows = [
        ...active.map((m) => ({ ...m, conditional: false })),
        ...conditional.map((m) => ({ ...m, conditional: true })),
      ];
      for (const row of rows) {
        if (!index.has(row.key)) {
          index.set(row.key, { key: row.key, label: '', providers: [] });
        }
        index.get(row.key).providers.push({
          category, categoryLabel: label, id, value: row.value, conditional: row.conditional,
        });
      }
    }
  }

  // Resolve display names once; searching against the rendered label is what
  // lets "research speed" find all_technology_research_speed.
  for (const entry of index.values()) {
    entry.label = plainText(view, modifierLabel(view, entry.key));
    entry.haystack = `${entry.label} ${entry.key}`.toLowerCase();
    entry.providers.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  }

  cache = { token, index };
  return index;
}

export function invalidateIndex() { cache = null; }

const PICKERS = {
  ethics: (app, id) => app.toggleEthic(id),
  civics: (app, id) => app.toggleCivic(id),
  species_traits: (app, id) => app.toggleTrait(id),
  leader_traits: (app, id) => app.toggleRulerTrait(id),
  authorities: (app, id) => app.set('authority', id),
  origins: (app, id) => app.set('origin', id),
};

function isPicked(build, category, id) {
  if (category === 'authorities') return build.authority === id;
  if (category === 'origins') return build.origin === id;
  const set = { ethics: build.ethics, civics: build.civics, species_traits: build.traits, leader_traits: build.rulerTraits }[category];
  return Boolean(set && set.has(id));
}

/** The panel. Owns its own search state and re-renders only its results. */
export function effectsPanel(app, onPicked) {
  const state = { term: '', onlyAvailable: false, hideConditional: false };
  const results = el('div', { class: 'effect-results' });

  const draw = () => renderResults(app, state, results, onPicked);

  const input = el('input', {
    class: 'search',
    type: 'search',
    placeholder: 'research speed, pop growth, alloys, unity…',
    style: 'width:280px',
    oninput: debounce((e) => { state.term = e.target.value; draw(); }, 140),
  });

  const toggle = (label, key, hint) => {
    const box = el('input', { type: 'checkbox', onchange: (e) => { state[key] = e.target.checked; draw(); } });
    return el('label', { class: 'nav-filter', title: hint }, box, el('span', {}, label));
  };

  const controls = el('div', { class: 'row' },
    input,
    toggle('Only what I can pick', 'onlyAvailable', 'Hide entries blocked by the current build'),
    toggle('Hide conditional', 'hideConditional', 'Hide modifiers gated behind a condition'));

  const panel = el('div', {},
    el('p', {}, 'Every modifier in the enabled mods, and everything that grants it. '
      + 'Click a result to add it to your build.'),
    controls,
    results);

  draw();
  setTimeout(() => input.focus(), 0);
  return panel;
}

function renderResults(app, state, holder, onPicked) {
  const { view } = app;
  const index = buildIndex(app);
  const term = state.term.trim().toLowerCase();

  if (!term) {
    holder.replaceChildren(el('p', { class: 'hint' },
      `${index.size} distinct modifiers across the enabled mods. Type to search.`));
    return;
  }

  const ctx = rules.makeContext(view, app.build);
  const matches = [...index.values()]
    .filter((entry) => entry.haystack.includes(term))
    .sort((a, b) => b.providers.length - a.providers.length || a.label.localeCompare(b.label));

  if (!matches.length) {
    holder.replaceChildren(el('p', { class: 'hint' }, `Nothing matches "${state.term}".`));
    return;
  }

  const nodes = [];
  const shownKeys = matches.slice(0, 30);
  for (const entry of shownKeys) {
    let providers = entry.providers;
    if (state.hideConditional) providers = providers.filter((p) => !p.conditional);

    const rows = [];
    for (const provider of providers) {
      const entity = view.cat[provider.category].get(provider.id);
      if (!entity) continue;
      // Ethics carry no potential/possible block - what stops you taking one is
      // the point budget and its axis, which is the wheel's rule. Use it here
      // too, or this panel will happily hand you an over-budget build.
      let verdict;
      let blocked;
      if (provider.category === 'ethics') {
        const why = ethicBlocker(app, entity);
        blocked = Boolean(why);
        verdict = { available: true, ok: !blocked, reasons: why ? [{ plain: why }] : [], unknown: [] };
      } else if (provider.category === 'species_traits') {
        verdict = rules.traitStatus(entity, ctx);
        blocked = !verdict.available || !verdict.ok;
      } else {
        verdict = rules.evaluate(entity, ctx);
        blocked = !verdict.available || !verdict.ok;
      }
      if (state.onlyAvailable && blocked) continue;
      rows.push({ provider, entity, verdict, blocked });
    }
    if (!rows.length) continue;

    const group = el('div', { class: 'effect-group' });
    group.append(el('div', { class: 'effect-head' },
      el('span', { class: 'effect-name', html: modifierLabel(view, entry.key) }),
      el('span', { class: 'effect-count' }, `${rows.length} source${rows.length === 1 ? '' : 's'}`)));

    for (const { provider, entity, verdict, blocked } of rows.slice(0, 25)) {
      const picked = isPicked(app.build, provider.category, provider.id);
      const row = el('button', {
        type: 'button',
        class: `effect-row${blocked ? ' blocked' : ''}${picked ? ' picked' : ''}`,
        title: blocked
          ? verdict.reasons.map((r) => r.plain || reasonText(view, r)).join(' · ') || 'Not available'
          : `${picked ? 'Remove' : 'Add'} ${nameOf(view, provider.id)}`,
        onclick: () => {
          if (blocked && !picked) return;
          const pick = PICKERS[provider.category];
          if (pick) { pick(app, provider.id); onPicked?.(); }
        },
      });

      const style = iconStyle(view, provider.id, 18);
      const icon = el('i', { class: 'ethic-ico' });
      if (style) icon.setAttribute('style', style);

      row.append(icon,
        el('span', { class: 'effect-label' }, nameOf(view, provider.id)),
        el('span', { class: 'effect-kind' }, provider.categoryLabel
          + (entity.src !== 'base' ? ` · ${app.sourceName(entity.src)}` : '')),
        el('span', { class: `effect-value ${modifierTone(view, entry.key, provider.value)}` },
          formatModifier(view, entry.key, provider.value)
          + (provider.conditional ? '*' : '')));
      group.append(row);
    }
    if (rows.length > 25) {
      group.append(el('div', { class: 'mod-more' }, `+${rows.length - 25} more sources`));
    }
    nodes.push(group);
  }

  if (!nodes.length) {
    nodes.push(el('p', { class: 'hint' }, 'Everything matching is filtered out by the checkboxes above.'));
  } else if (matches.length > shownKeys.length) {
    nodes.push(el('p', { class: 'hint' },
      `Showing ${shownKeys.length} of ${matches.length} matching modifiers — narrow the search to see the rest.`));
  }
  nodes.push(el('p', { class: 'hint' }, '* only applies while its condition holds.'));
  holder.replaceChildren(...nodes);
}
