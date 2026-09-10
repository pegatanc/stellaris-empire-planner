// App wiring: state, derived values, re-render, and the modal dialogs.

import { loadDatabase, buildView, contentSources } from './data.js';
import * as ui from './ui.js';
import * as rules from './rules.js';
import * as exporter from './export.js';
import { parseEmpireDesigns } from './empirefile.js';
import { el, debounce } from './util.js';

const app = {
  db: null,
  view: null,
  build: null,
  ctx: null,
  budgets: null,
  modifiers: null,
  enabledSources: new Set(),
  contentSources: new Set(),
  sourceCounts: new Map(),
  search: {},
  hideBlocked: false,
};

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

boot().catch((error) => {
  document.getElementById('loading').hidden = true;
  const fatal = document.getElementById('fatal');
  fatal.hidden = false;
  fatal.textContent = `Could not start the planner.\n\n${error.message}\n\n`
    + 'If you are opening index.html straight from disk, the browser blocks the data files. '
    + 'Serve the folder instead, e.g. `python -m http.server` in the project directory.';
  console.error(error);
});

async function boot() {
  app.db = await loadDatabase();
  app.contentSources = contentSources(app.db);
  app.sourceCounts = countBySource(app.db);
  app.enabledSources = new Set(app.db.meta.sources.map((s) => s.id));
  app.build = defaultBuild();

  wireChrome();

  const hash = location.hash.replace(/^#b=/, '');
  if (hash && location.hash.startsWith('#b=')) {
    try {
      exporter.applyEncoded(app, exporter.decodeBuild(hash));
    } catch (error) {
      console.warn('ignoring unreadable share link', error);
    }
  }

  rerender({ rail: true });
  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden = false;
}

function countBySource(db) {
  const counts = new Map();
  const bump = (src, key) => {
    if (!counts.has(src)) counts.set(src, {});
    const bucket = counts.get(src);
    bucket[key] = (bucket[key] || 0) + 1;
  };
  for (const [category, items] of Object.entries(db.entities)) {
    const seen = new Set();
    for (const entity of items) {
      const token = `${entity.src}|${entity.id}`;
      if (seen.has(token)) continue;
      seen.add(token);
      bump(entity.src, category);
    }
  }
  for (const entry of db.defines) bump(entry.src, 'defines');
  return counts;
}

function defaultBuild() {
  const view = buildView(app.db, app.enabledSources);
  const speciesClass = view.cat.species_classes.has('HUM') ? 'HUM' : 'MAM';
  const shipset = view.cat.species_classes.get(speciesClass)?.data.graphical_culture || 'mammalian_01';
  return {
    name: 'New Empire',
    adjective: '',
    shipPrefix: '',
    speciesClass,
    speciesName: '',
    speciesPlural: '',
    speciesAdjective: '',
    portrait: '',
    nameList: view.cat.name_lists.has('HUMAN1') ? 'HUMAN1' : [...view.cat.name_lists.keys()][0] || '',
    shipset,
    planetClass: 'pc_continental',
    planetName: '',
    systemName: '',
    room: app.db.options.rooms.includes('personality_federation_builders_room')
      ? 'personality_federation_builders_room'
      : app.db.options.rooms[0] || '',
    advisorVoice: '',
    isNomadic: false,
    ethics: new Set(),
    authority: 'auth_democratic',
    civics: new Set(),
    origin: 'origin_default',
    traits: new Set(),
    rulerTraits: new Set(),
    ruler: { name: '', gender: 'not_set', title: '', titleFemale: '', leaderClass: 'official', portrait: '' },
    flagColors: ['blue', 'black', 'null', 'null'],
    dlcs: new Set(app.db.options.dlcs.map((d) => d.name)),
  };
}

// --------------------------------------------------------------------------
// Derived state + render
// --------------------------------------------------------------------------

function recompute() {
  app.view = buildView(app.db, app.enabledSources);
  app.ctx = rules.makeContext(app.view, app.build);
  app.modifiers = rules.aggregateModifiers(app.view, app.build);
  app.budgets = rules.computeBudgets(app.view, app.build, app.modifiers.totals);
  // Budgets feed back into requirements (a civic can grant civic points), so
  // rebuild the context once the totals are known.
  app.ctx = rules.makeContext(app.view, app.build);
}

function rerender({ rail = false } = {}) {
  const active = document.activeElement;
  const focusId = active && active.dataset ? active.dataset.focusId : null;
  const caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;

  recompute();
  ui.renderBudgets(app);
  ui.renderMain(app);
  ui.renderStats(app);
  if (rail) ui.renderRail(app);
  ui.renderNav(app);
  renderValidityChip();
  syncHash();

  if (focusId) {
    const next = document.querySelector(`[data-focus-id="${CSS.escape(focusId)}"]`);
    if (next) {
      next.focus();
      if (caret !== null && typeof next.setSelectionRange === 'function') {
        try { next.setSelectionRange(caret, caret); } catch { /* not a text input */ }
      }
    }
  }
}
app.rerender = rerender;

// Text fields never change what is legal, so typing only refreshes the light
// parts - re-rendering the card grids on every keystroke would be wasteful and
// would fight the caret.
const lightRefresh = debounce(() => {
  recompute();
  ui.renderStats(app);
  syncHash();
}, 250);
app.scheduleLightRefresh = lightRefresh;

function syncHash() {
  try {
    const code = exporter.encodeBuild(app);
    history.replaceState(null, '', `#b=${code}`);
  } catch (error) {
    console.warn('could not update share link', error);
  }
}

// --------------------------------------------------------------------------
// Mutations
// --------------------------------------------------------------------------

app.set = (key, value) => { app.build[key] = value; rerender(); };

app.setSpeciesClass = (value) => {
  app.build.speciesClass = value;
  const entity = app.view.cat.species_classes.get(value);
  if (entity?.data.graphical_culture) app.build.shipset = entity.data.graphical_culture;
  // Traits are archetype-gated, so drop any that no longer apply.
  const ctx = rules.makeContext(app.view, app.build);
  for (const id of [...app.build.traits]) {
    const trait = app.view.cat.species_traits.get(id);
    if (!trait || !rules.traitStatus(trait, ctx).available) app.build.traits.delete(id);
  }
  rerender();
};

app.toggleEthic = (id) => {
  const { ethics } = app.build;
  if (ethics.has(id)) ethics.delete(id);
  else {
    if (id === 'ethic_gestalt_consciousness') ethics.clear();
    else ethics.delete('ethic_gestalt_consciousness');
    const entity = app.view.cat.ethics.get(id);
    const category = entity?.data.category;
    for (const other of [...ethics]) {
      if (app.view.cat.ethics.get(other)?.data.category === category) ethics.delete(other);
    }
    ethics.add(id);
  }
  rerender();
};

// Hovering the wheel only swaps the detail panel; a full repaint per mousemove
// would be absurd.
app.ethicHover = null;
app.setEthicHover = (id) => {
  if (app.ethicHover === id) return;
  app.ethicHover = id;
  const detail = document.querySelector('.ethic-detail');
  if (detail) ui.fillEthicDetail(app, detail);
};

const toggleIn = (set, id) => (set.has(id) ? set.delete(id) : set.add(id));
app.toggleCivic = (id) => { toggleIn(app.build.civics, id); rerender(); };
app.toggleTrait = (id) => { toggleIn(app.build.traits, id); rerender(); };
app.toggleRulerTrait = (id) => { toggleIn(app.build.rulerTraits, id); rerender(); };

app.toggleSource = (id) => {
  toggleIn(app.enabledSources, id);
  rerender({ rail: true });
};
app.setSources = (ids) => {
  app.enabledSources = new Set(['base', ...ids]);
};
app.toggleDlc = (name) => { toggleIn(app.build.dlcs, name); rerender({ rail: true }); };

app.sourceName = (id) => app.db.meta.sources.find((s) => s.id === id)?.name || id;

// --------------------------------------------------------------------------
// Validation summary
// --------------------------------------------------------------------------

app.issues = () => {
  const { view, ctx, build, budgets } = app;
  const out = [];
  const label = (id) => ui.nameOf(view, id);

  const check = (category, id, kind, section) => {
    if (!id) return;
    const entity = view.cat[category]?.get(id);
    if (!entity) {
      out.push({ kind: 'error', section, label: label(id), text: `${kind} is not in the enabled data` });
      return;
    }
    const verdict = rules.evaluate(entity, ctx);
    if (!verdict.available) {
      out.push({ kind: 'error', section, label: label(id), text: `${kind} is not offered with these picks` });
    } else if (!verdict.ok) {
      out.push({ kind: 'error', section, label: label(id), text: describe(view, verdict.reasons) });
    }
    if (verdict.unknown.length) {
      out.push({
        kind: 'warn',
        section,
        label: label(id),
        text: `unverified — this tool cannot check ${verdict.unknown.join(', ')}`,
      });
    }
  };

  check('authorities', build.authority, 'authority', 'authority');
  check('origins', build.origin, 'origin', 'origin');
  for (const id of build.civics) check('civics', id, 'civic', 'civics');

  for (const id of build.traits) {
    const entity = view.cat.species_traits.get(id);
    if (!entity) continue;
    const status = rules.traitStatus(entity, ctx);
    if (!status.ok) {
      out.push({ kind: 'error', section: 'traits', label: label(id), text: describe(view, status.reasons) });
    }
  }

  const pools = [
    ['Ethic points', budgets.ethics, 'ethics'],
    ['Civics', budgets.civics, 'civics'],
    ['Trait points', budgets.traitPoints, 'traits'],
    ['Trait picks', budgets.traitPicks, 'traits'],
  ];
  for (const [name, pool, section] of pools) {
    if (pool.used > pool.max) {
      out.push({ kind: 'error', section, label: name, text: `over budget: ${pool.used} of ${pool.max}` });
    }
  }
  if (!build.authority) {
    out.push({ kind: 'error', section: 'authority', label: 'Authority', text: 'nothing selected' });
  }

  return out;
};

function describe(view, reasons) {
  if (!reasons.length) return 'requirements not met';
  return reasons.map((reason) => {
    const text = ui.reasonText(view, reason);
    return text.charAt(0).toLowerCase() + text.slice(1);
  }).join('; ');
}

function renderValidityChip() {
  const chip = document.getElementById('btn-validity');
  const issues = app.issues();
  const errors = issues.filter((i) => i.kind === 'error');
  const warns = issues.filter((i) => i.kind === 'warn');

  chip.classList.remove('ok', 'bad', 'warn');
  if (errors.length) {
    chip.classList.add('bad');
    chip.textContent = `${errors.length} problem${errors.length === 1 ? '' : 's'}`;
  } else if (warns.length) {
    chip.classList.add('warn');
    chip.textContent = `${warns.length} unverified`;
  } else {
    chip.classList.add('ok');
    chip.textContent = 'Valid build';
  }
}

// --------------------------------------------------------------------------
// Modal
// --------------------------------------------------------------------------

function openModal(title, ...nodes) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').replaceChildren(...nodes);
  document.getElementById('modal').hidden = false;
}
function closeModal() { document.getElementById('modal').hidden = true; }

function textArea(value) {
  const node = el('textarea', { readonly: true, spellcheck: 'false' });
  node.value = value;
  return node;
}

function copyButton(label, getText) {
  return el('button', {
    type: 'button',
    class: 'btn btn-sm',
    onclick: async (event) => {
      try {
        await navigator.clipboard.writeText(getText());
        event.target.textContent = 'Copied';
        setTimeout(() => { event.target.textContent = label; }, 1400);
      } catch {
        event.target.textContent = 'Press Ctrl+C';
      }
    },
  }, label);
}

function wireChrome() {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (event) => {
    if (event.target.id === 'modal') closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });

  for (const button of document.querySelectorAll('[data-preset]')) {
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
  }

  document.getElementById('chk-hide-blocked').addEventListener('change', (e) => {
    app.hideBlocked = e.target.checked;
    rerender();
  });
  document.getElementById('btn-rail').addEventListener('click', () => {
    document.getElementById('rail').classList.toggle('open');
  });
  document.getElementById('btn-stats').addEventListener('click', () => {
    document.getElementById('stats').classList.toggle('open');
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    // Names and the mod selection are the expensive things to retype, so a
    // reset clears the picks and leaves those alone.
    const kept = {
      name: app.build.name,
      adjective: app.build.adjective,
      shipPrefix: app.build.shipPrefix,
      speciesName: app.build.speciesName,
      speciesPlural: app.build.speciesPlural,
      speciesAdjective: app.build.speciesAdjective,
      dlcs: app.build.dlcs,
    };
    app.build = { ...defaultBuild(), ...kept };
    rerender({ rail: true });
  });
  document.getElementById('btn-validity').addEventListener('click', showIssues);
  document.getElementById('btn-export').addEventListener('click', showExport);
  document.getElementById('btn-save').addEventListener('click', showSave);
  document.getElementById('btn-load').addEventListener('click', showLoad);
  document.getElementById('btn-compare').addEventListener('click', showCompare);
}

function applyPreset(preset) {
  if (preset === 'playset') app.enabledSources = new Set(app.db.meta.sources.map((s) => s.id));
  else if (preset === 'vanilla') app.enabledSources = new Set(['base']);
  else if (preset === 'dlc-all') app.build.dlcs = new Set(app.db.options.dlcs.map((d) => d.name));
  else if (preset === 'dlc-none') app.build.dlcs = new Set();
  rerender({ rail: true });
}

function showIssues() {
  const issues = app.issues();
  if (!issues.length) {
    openModal('Validation', el('p', {}, 'Every pick satisfies its requirements.'));
    return;
  }
  const list = el('div', { class: 'issue-list' });
  for (const issue of issues) {
    list.append(el('div', { class: `issue${issue.kind === 'warn' ? ' warn' : ''}` },
      el('b', {}, issue.label), ' — ', issue.text));
  }
  openModal('Validation', list);
}

function showExport() {
  const empireText = exporter.exportEmpireFile(app);
  const shareUrl = `${location.origin}${location.pathname}#b=${exporter.encodeBuild(app)}`;

  const panes = {
    empire: () => [
      el('p', { html: 'Paste this block into <code>Documents\\Paradox Interactive\\Stellaris\\user_empire_designs_v3.4.txt</code>, '
        + 'inside the outermost braces alongside the empires already there. Back the file up first.' }),
      el('div', { class: 'row' }, copyButton('Copy empire block', () => empireText)),
      textArea(empireText),
    ],
    share: () => [
      el('p', {}, 'The whole build is encoded in the link. No server, no account.'),
      el('div', { class: 'row' }, copyButton('Copy link', () => shareUrl)),
      textArea(shareUrl),
    ],
    markdown: () => {
      const text = exporter.exportMarkdown(app);
      return [
        el('div', { class: 'row' }, copyButton('Copy Markdown', () => text)),
        textArea(text),
      ];
    },
    json: () => {
      const text = exporter.exportJSON(app);
      return [
        el('div', { class: 'row' }, copyButton('Copy JSON', () => text)),
        textArea(text),
      ];
    },
  };

  const body = el('div', {});
  const tabs = el('div', { class: 'row' });
  const show = (key) => body.replaceChildren(...panes[key]());
  for (const [key, label] of [['empire', 'Stellaris empire file'], ['share', 'Share link'], ['markdown', 'Markdown sheet'], ['json', 'JSON']]) {
    tabs.append(el('button', { type: 'button', class: 'btn btn-sm', onclick: () => show(key) }, label));
  }
  show('empire');
  openModal('Export', tabs, body);
}

function showSave() {
  const input = el('input', { class: 'search', type: 'text', value: app.build.name || 'Build', style: 'width:240px' });
  const status = el('p', {});
  const body = el('div', {},
    el('p', {}, 'Saved in this browser only.'),
    el('div', { class: 'row' }, input, el('button', {
      type: 'button', class: 'btn btn-primary',
      onclick: () => {
        const label = input.value.trim() || 'Build';
        status.textContent = exporter.saveSlot(app, label)
          ? `Saved as "${label}".`
          : 'Could not save — browser storage is unavailable.';
      },
    }, 'Save')),
    status);
  openModal('Save build', body);
}

function slotList(onPick, { withDelete = true } = {}) {
  const slots = exporter.loadSlots();
  if (!slots.length) return el('p', {}, 'No saved builds yet.');
  const list = el('div', { class: 'slot-list' });
  for (const slot of slots) {
    const row = el('div', { class: 'slot' },
      el('div', { class: 'grow' },
        el('div', {}, slot.label),
        el('div', { class: 'meta' }, new Date(slot.saved).toLocaleString())),
      el('button', { type: 'button', class: 'btn btn-sm', onclick: () => onPick(slot) }, 'Use'));
    if (withDelete) {
      row.append(el('button', {
        type: 'button', class: 'btn btn-sm',
        onclick: () => { exporter.deleteSlot(slot.label); row.remove(); },
      }, 'Delete'));
    }
    list.append(row);
  }
  return list;
}

function showLoad() {
  const body = el('div', {});
  const rebuild = () => body.replaceChildren(
    el('p', {}, 'Load a saved build, a share link, or an empire straight out of your Stellaris file.'),
    slotList((slot) => {
      exporter.applyEncoded(app, exporter.decodeBuild(slot.code));
      rerender({ rail: true });
      closeModal();
    }),
    el('h3', { style: 'margin:18px 0 8px;font-size:13px' }, 'Paste a share link or an empire block'),
    pasteBox(),
  );
  rebuild();
  openModal('Load build', body);
}

function pasteBox() {
  const area = el('textarea', { spellcheck: 'false', placeholder: 'Paste a share link, or a block from user_empire_designs_v3.4.txt' });
  area.readOnly = false;
  const status = el('p', {});
  return el('div', {},
    area,
    el('div', { class: 'row', style: 'margin-top:8px' }, el('button', {
      type: 'button', class: 'btn btn-primary',
      onclick: () => {
        const text = area.value.trim();
        if (!text) return;
        try {
          if (text.includes('#b=')) {
            exporter.applyEncoded(app, exporter.decodeBuild(text.split('#b=')[1].trim()));
          } else {
            const empires = parseEmpireDesigns(text);
            if (!empires.length) throw new Error('no empire block found');
            applyEmpire(empires[0]);
          }
          rerender({ rail: true });
          closeModal();
        } catch (error) {
          status.textContent = `Could not read that: ${error.message}`;
        }
      },
    }, 'Load')),
    status);
}

function applyEmpire(empire) {
  const { build } = app;
  build.name = empire.name;
  build.adjective = empire.adjective;
  build.shipPrefix = empire.shipPrefix;
  build.speciesClass = empire.speciesClass || build.speciesClass;
  build.speciesName = empire.speciesName;
  build.speciesPlural = empire.speciesPlural;
  build.speciesAdjective = empire.speciesAdjective;
  build.portrait = empire.portrait;
  build.nameList = empire.nameList || build.nameList;
  build.shipset = empire.shipset || build.shipset;
  build.planetClass = empire.planetClass || build.planetClass;
  build.planetName = empire.planetName;
  build.systemName = empire.systemName;
  build.room = empire.room || build.room;
  build.advisorVoice = empire.advisorVoice;
  build.isNomadic = empire.isNomadic;
  build.authority = empire.authority;
  build.origin = empire.origin;
  build.ethics = new Set(empire.ethics);
  build.civics = new Set(empire.civics);

  // Traits granted by the origin, civics or species class are re-derived rather
  // than treated as picks, so they do not eat the trait budget twice.
  const view = buildView(app.db, app.enabledSources);
  const forced = rules.forcedTraits(view, build);
  build.traits = new Set(empire.traits.filter((id) => !forced.locked.has(id)));
  build.rulerTraits = new Set(empire.ruler.traits);
  build.ruler = {
    name: empire.ruler.name,
    gender: empire.ruler.gender || 'not_set',
    title: empire.ruler.title,
    titleFemale: empire.ruler.titleFemale,
    leaderClass: empire.ruler.leaderClass || 'official',
    portrait: empire.ruler.portrait,
  };
}

function showCompare() {
  const slots = exporter.loadSlots();
  if (!slots.length) {
    openModal('Compare builds', el('p', {}, 'Save at least one build first, then compare it against the one you are editing.'));
    return;
  }
  const body = el('div', {});
  body.append(
    el('p', {}, 'Comparing the build you are editing against a saved one.'),
    slotList((slot) => renderDiff(body, slot), { withDelete: false }),
  );
  openModal('Compare builds', body);
}

function renderDiff(body, slot) {
  const current = snapshot(app);
  const other = snapshotFromCode(slot.code);

  const rows = [
    ['Empire name', current.name, other.name],
    ['Species class', current.speciesClass, other.speciesClass],
    ['Authority', current.authority, other.authority],
    ['Origin', current.origin, other.origin],
    ['Ethics', current.ethics, other.ethics],
    ['Civics', current.civics, other.civics],
    ['Species traits', current.traits, other.traits],
    ['Ruler traits', current.rulerTraits, other.rulerTraits],
    ['Ship appearance', current.shipset, other.shipset],
    ['Homeworld', current.planetClass, other.planetClass],
  ];

  const table = el('table', { class: 'diff-table' },
    el('thead', {}, el('tr', {},
      el('th', {}, ''), el('th', {}, 'Editing'), el('th', {}, slot.label))));
  const tbody = el('tbody', {});
  for (const [label, a, b] of rows) {
    const same = a === b;
    tbody.append(el('tr', {},
      el('th', {}, label),
      el('td', { class: same ? 'same' : 'a' }, a || '—'),
      el('td', { class: same ? 'same' : 'b' }, b || '—')));
  }

  const keys = new Set([...current.modifiers.keys(), ...other.modifiers.keys()]);
  for (const key of [...keys].sort()) {
    const a = current.modifiers.get(key) || 0;
    const b = other.modifiers.get(key) || 0;
    if (a === b) continue;
    tbody.append(el('tr', {},
      el('th', {}, key),
      el('td', { class: 'a' }, String(Math.round(a * 1000) / 1000)),
      el('td', { class: 'b' }, String(Math.round(b * 1000) / 1000))));
  }

  table.append(tbody);
  body.replaceChildren(
    el('div', { class: 'row' }, el('button', {
      type: 'button', class: 'btn btn-sm', onclick: () => showCompare(),
    }, '← pick another')),
    table,
  );
}

function snapshot(target) {
  const { view, build } = target;
  const names = (ids) => [...ids].map((id) => ui.nameOf(view, id)).sort().join(', ');
  return {
    name: build.name,
    speciesClass: ui.nameOf(view, build.speciesClass),
    authority: ui.nameOf(view, build.authority),
    origin: ui.nameOf(view, build.origin),
    ethics: names(build.ethics),
    civics: names(build.civics),
    traits: names(build.traits),
    rulerTraits: names(build.rulerTraits),
    shipset: build.shipset,
    planetClass: ui.nameOf(view, build.planetClass),
    modifiers: target.modifiers.totals,
  };
}

function snapshotFromCode(code) {
  const clone = {
    db: app.db,
    enabledSources: new Set(app.enabledSources),
    build: defaultBuild(),
    setSources(ids) { this.enabledSources = new Set(['base', ...ids]); },
  };
  exporter.applyEncoded(clone, exporter.decodeBuild(code));
  clone.view = buildView(clone.db, clone.enabledSources);
  clone.ctx = rules.makeContext(clone.view, clone.build);
  clone.modifiers = rules.aggregateModifiers(clone.view, clone.build);
  return snapshot(clone);
}
