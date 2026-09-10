// Rendering Stellaris localisation strings.
//
// Game text is marked up, not plain: §Y…§! colour runs, £icon£ inline sprites,
// $NESTED_KEY$ substitution, $VALUE|+%0$ number formatting and ['concept'] links.
// Dumping the raw string would show the markup; this turns it into HTML.

import { esc } from './util.js';

// interface/fonts.gfx textcolors, as RGB triples.
const COLORS = {
  M: '#a335ee', L: '#c3b091', G: '#29e126', R: '#fc5646',
  B: '#33a7ff', Y: '#f7fc34', H: '#fbaa29', C: '#1fe0ca',
  K: '#fbaa29', I: '#f7fc34', T: '#ffffff', t: '#c6c6c6',
  E: '#87ffcf', S: '#e49c2a', W: '#ffffff', P: '#e16e6e',
  V: '#4c8a71', g: '#808080', _: '#ff00ff', U: '#ccb3ff',
  A: '#e1aa3b', c: '#3cd092', v: '#8baea2', d: '#ffdd7a',
  r: '#a382ff', l: '#b2ec68', 0: '#1fe0ca', 1: '#33a7ff',
  2: '#a335ee', 3: '#fbaa29',
};

const MAX_NESTING = 8;

export function iconStyle(view, key, size) {
  const cell = view.icon(key);
  if (!cell) return null;
  const [x, y, w, h] = cell;
  const [sheetW, sheetH] = view.db.icons.size;
  const scale = size ? size / Math.max(w, h) : 1;
  return [
    `width:${(w * scale).toFixed(2)}px`,
    `height:${(h * scale).toFixed(2)}px`,
    `background-image:url('${view.db.icons.sheet}')`,
    `background-position:${(-x * scale).toFixed(2)}px ${(-y * scale).toFixed(2)}px`,
    `background-size:${(sheetW * scale).toFixed(2)}px ${(sheetH * scale).toFixed(2)}px`,
  ].join(';');
}

export function iconHTML(view, key, size = 16, cls = 'ticon') {
  const style = iconStyle(view, key, size);
  if (!style) return '';
  return `<i class="${cls}" style="${style}"></i>`;
}

/** Render a raw localisation string to HTML. */
export function renderText(view, raw, params = {}, depth = 0) {
  if (!raw) return '';
  if (depth > MAX_NESTING) return esc(raw);

  const out = [];
  let open = 0;
  let i = 0;
  let plain = '';

  const flush = () => { if (plain) { out.push(esc(plain)); plain = ''; } };

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '\\' && raw[i + 1] === 'n') {
      flush(); out.push('<br>'); i += 2; continue;
    }
    if (ch === '\n') { flush(); out.push('<br>'); i += 1; continue; }

    if (ch === '§') {
      const code = raw[i + 1];
      flush();
      if (code === '!') {
        if (open > 0) { out.push('</span>'); open -= 1; }
      } else if (code !== undefined) {
        out.push(`<span style="color:${COLORS[code] || 'inherit'}">`);
        open += 1;
      }
      i += 2;
      continue;
    }

    if (ch === '£') {
      const end = raw.indexOf('£', i + 1);
      const body = end === -1 ? raw.slice(i + 1).split(/\s/)[0] : raw.slice(i + 1, end);
      const token = body.split('|')[0];
      flush();
      out.push(iconHTML(view, `text_${token}`, 15) || '');
      i = end === -1 ? i + 1 + body.length : end + 1;
      continue;
    }

    if (ch === '$') {
      const end = raw.indexOf('$', i + 1);
      if (end === -1) { plain += ch; i += 1; continue; }
      const body = raw.slice(i + 1, end);
      flush();
      out.push(expandToken(view, body, params, depth));
      i = end + 1;
      continue;
    }

    if (ch === '[') {
      const end = raw.indexOf(']', i + 1);
      if (end === -1) { plain += ch; i += 1; continue; }
      flush();
      out.push(renderScriptedToken(view, raw.slice(i + 1, end)));
      i = end + 1;
      continue;
    }

    plain += ch;
    i += 1;
  }

  flush();
  while (open > 0) { out.push('</span>'); open -= 1; }
  return out.join('');
}

/** Same, but stripped back to plain text (tooltips, exports, search). */
export function plainText(view, raw, params = {}) {
  const html = renderText(view, raw, params);
  const holder = document.createElement('div');
  holder.innerHTML = html.replace(/<br>/g, '\n');
  return holder.textContent.trim();
}

function expandToken(view, body, params, depth) {
  const pipe = body.indexOf('|');
  const name = pipe === -1 ? body : body.slice(0, pipe);
  const spec = pipe === -1 ? '' : body.slice(pipe + 1);

  if (Object.prototype.hasOwnProperty.call(params, name)) {
    return formatValue(params[name], spec);
  }
  const nested = view.loc(name);
  if (nested) return renderText(view, nested, params, depth + 1);
  return esc(name);
}

// Scripted-loc tokens can't be evaluated without the game running. Concept links
// have a readable name in the loc data; the rest degrade to nothing rather than
// showing raw script.
function renderScriptedToken(view, body) {
  const concept = body.match(/^'([A-Za-z0-9_]+)'$/);
  if (concept) {
    const key = concept[1];
    const name = view.loc(key) || key.replace(/^concept_/, '').replace(/_/g, ' ');
    return `<span class="concept">${esc(stripMarkup(name))}</span>`;
  }
  return '';
}

function stripMarkup(text) {
  return String(text).replace(/§./g, '').replace(/£[^£\s]*£?/g, '').trim();
}

/**
 * The $VALUE|spec$ grammar, documented verbatim in
 * common/static_modifiers/000_readme.txt.
 */
export function formatValue(value, spec = '') {
  let n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return esc(value);

  const multiplier = spec.match(/\((\d+(?:\.\d+)?)\)/);
  if (multiplier) n *= parseFloat(multiplier[1]);

  const percent = spec.includes('%');
  if (percent) n *= 100;

  if (spec.includes('_') && n === 0) return '';

  const decimals = (spec.match(/(\d)/) || [])[1];
  let text = decimals !== undefined ? n.toFixed(Number(decimals)) : trimNumber(n);
  if ((spec.includes('=') || spec.includes('+')) && n > 0) text = `+${text}`;
  if (percent) text += '%';

  let color = null;
  if (spec.includes('+')) color = n >= 0 ? COLORS.G : COLORS.R;
  if (spec.includes('-')) color = n >= 0 ? COLORS.R : COLORS.G;
  for (const ch of spec) {
    if (ch !== '+' && ch !== '-' && COLORS[ch] && !/\d/.test(ch)) color = COLORS[ch];
  }

  return color ? `<span style="color:${color}">${esc(text)}</span>` : esc(text);
}

function trimNumber(n) {
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

// --------------------------------------------------------------------------
// Modifiers
// --------------------------------------------------------------------------

/**
 * There is no data file saying which modifiers are percentages - the engine
 * decides from the identifier suffix, so we do the same.
 */
export function isPercentModifier(key) {
  return /_(mult|chance)$/.test(key);
}

export function modifierName(view, key) {
  const direct = view.loc(`mod_${key}`);
  if (direct) return direct;
  const upper = view.loc(`MOD_${key.toUpperCase()}`);
  if (upper) return upper;
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatModifier(view, key, value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return esc(String(value));
  if (isPercentModifier(key)) {
    const pct = Math.round(n * 1000) / 10;
    return `${pct > 0 ? '+' : ''}${pct}%`;
  }
  return `${n > 0 ? '+' : ''}${trimNumber(n)}`;
}

/** Resolve a modifier label, following the mod_x -> $MOD_X$ indirection. */
export function modifierLabel(view, key) {
  const raw = modifierName(view, key);
  return renderText(view, raw, {});
}
