// Differential check for the render cache.
//
//   open index.html?selftest=render
//
// `renderMain` skips rebuilding a card-grid section whose signature is
// unchanged. That is only safe if the signature really does capture everything
// the section's markup depends on: miss one input and the page silently shows
// stale cards, which is the worst kind of bug because nothing throws.
//
// So this walks the build through a long series of mutations and, after each
// one, compares the DOM the cache produced against the DOM a full rebuild
// produces. They must be byte-identical.
// It is loaded only when asked for, so it costs a normal visit nothing.
//
// Query parameters: `rounds` (default 240) and `seed` (default 1). The shuffle
// is seeded, so a failure reproduces exactly.

import * as ui from './ui.js';

/** Section markup keyed by section id, for comparing one render to another. */
function snapshot() {
  const out = new Map();
  for (const section of document.querySelectorAll('#main > section')) {
    out.set(section.id, section.innerHTML);
  }
  return out;
}

/**
 * Render twice - once however the cache decides, once from scratch - and report
 * every section where the two disagree.
 */
function compareRenders(app) {
  const cached = snapshot();
  ui.invalidateSections();
  ui.renderMain(app);
  const fresh = snapshot();

  const stale = [];
  for (const [id, html] of fresh) {
    const before = cached.get(id);
    if (before === undefined) { stale.push(`${id} (missing from cached render)`); continue; }
    if (before !== html) stale.push(id);
  }
  for (const id of cached.keys()) {
    if (!fresh.has(id)) stale.push(`${id} (missing from fresh render)`);
  }
  return { stale };
}

/** A deterministic shuffle, so a failure can be reproduced exactly. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function mutations(app) {
  const { view } = app;
  const ids = (cat) => [...view.cat[cat].keys()];
  const pick = (list, rnd) => list[Math.floor(rnd() * list.length)];

  return [
    ['toggle a civic', (rnd) => app.toggleCivic(pick(ids('civics'), rnd))],
    ['set an origin', (rnd) => app.set('origin', pick(ids('origins'), rnd))],
    ['set an authority', (rnd) => app.set('authority', pick(ids('authorities'), rnd))],
    ['toggle a species trait', (rnd) => app.toggleTrait(pick(ids('species_traits'), rnd))],
    ['toggle a ruler trait', (rnd) => app.toggleRulerTrait(pick(ids('leader_traits'), rnd))],
    ['toggle an ethic', (rnd) => app.toggleEthic(pick(ids('ethics'), rnd))],
    ['toggle hide-blocked', () => { app.hideBlocked = !app.hideBlocked; app.rerender(); }],
    ['type in the civics filter', (rnd) => {
      app.search.civics = pick(['', 'unity', 'crime', 'a', 'zzz'], rnd);
      app.rerender();
    }],
    ['type in the traits filter', (rnd) => {
      app.search.traits = pick(['', 'lifespan', 'e', 'zzz'], rnd);
      app.rerender();
    }],
    ['toggle a mod', (rnd) => {
      const toggleable = app.db.meta.sources
        .filter((s) => s.id !== 'base' && app.contentSources.has(s.id))
        .map((s) => s.id);
      if (toggleable.length) app.toggleSource(pick(toggleable, rnd));
    }],
  ];
}

export function runRenderSelfTest(app, { rounds = 240, seed = 1 } = {}) {
  const rnd = makeRandom(seed);
  const steps = mutations(app);
  const failures = [];
  let checked = 0;

  // A clean baseline: whatever is on screen now, rebuilt from scratch.
  ui.invalidateSections();
  ui.renderMain(app);

  for (let i = 0; i < rounds; i += 1) {
    const [label, run] = steps[Math.floor(rnd() * steps.length)];
    try {
      run(rnd);
    } catch (error) {
      failures.push({ round: i, label, stale: [`threw: ${error.message}`] });
      continue;
    }
    const { stale } = compareRenders(app);
    checked += 1;
    if (stale.length) failures.push({ round: i, label, stale });
  }

  const pass = failures.length === 0;
  const summary = pass
    ? `render self-test: ${checked} mutations, cached and full renders identical every time`
    : `render self-test: ${failures.length} of ${checked} mutations left stale markup`;

  if (pass) console.log(`%c${summary}`, 'color:#4ade80;font-weight:bold');
  else {
    console.error(summary);
    for (const f of failures.slice(0, 20)) {
      console.error(`  round ${f.round} after "${f.label}": ${f.stale.join(', ')}`);
    }
  }

  const banner = document.createElement('div');
  banner.setAttribute('style', [
    'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:9999',
    'padding:10px 16px', 'font:600 13px/1.4 system-ui,sans-serif',
    `background:${pass ? '#14532d' : '#7f1d1d'}`, 'color:#fff',
  ].join(';'));
  banner.textContent = summary;
  banner.id = 'selftest-banner';
  document.body.append(banner);

  return { pass, checked, failures };
}
