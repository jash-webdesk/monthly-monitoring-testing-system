/**
 * Canonical Before/After performance scores, supplied per run (never hard-coded).
 *
 * Canonical shape:
 *   { "<pageKey>": { label?: string, mobile: { before, after }, desktop: { before, after } }, ... }
 * Accepted input variations (all normalised to the canonical shape):
 *   - page value with arrays:   { "Homepage": { "mobile": [68, 74], "desktop": [79, 83] } }
 *   - page value with objects:  { "Homepage": { "mobile": { "before": 68, "after": 74 } } }
 *   - per-site wrapper:         { "genpet.org": { "Homepage": { ... } } }  (keys that look like hostnames)
 *   - compact text:             "Homepage Mobile 68>74, Desktop 79>83; About Us Mobile 71>77, Desktop 82>87"
 *   - prompt-builder text:      "PartsConnexion: Homepage Mobile Before 68 -> After 74, Desktop Before 79 -> After 83"
 * Any number of pages and either viewport may be omitted.
 */

const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const looksLikeHost = (k) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(k);

function num(v, where) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`Invalid score "${v}" at ${where} (expected 0-100)`);
  return n;
}

function pair(v, where) {
  if (v == null) return null;
  if (Array.isArray(v)) return { before: num(v[0], where + '.before'), after: num(v[1], where + '.after') };
  if (typeof v === 'object') return { before: num(v.before, where + '.before'), after: num(v.after, where + '.after') };
  throw new Error(`Invalid score pair at ${where}`);
}

function normalizePages(obj, where = 'scores') {
  const out = {};
  for (const [label, val] of Object.entries(obj)) {
    const key = slug(label);
    const page = { label };
    for (const vp of ['mobile', 'desktop']) {
      const p = pair(val[vp], `${where}.${label}.${vp}`);
      if (p) page[vp] = p;
    }
    if (!page.mobile && !page.desktop) throw new Error(`Page "${label}" has neither mobile nor desktop scores`);
    out[key] = page;
  }
  return out;
}

const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Builds the label -> hostname lookup used to read "PartsConnexion: Homepage ..." style lines. */
export function siteAliases(sites, displayNames = {}) {
  const map = new Map();
  for (const s of sites) {
    const host = s.hostname;
    const bare = host.replace(/^www\./, '');
    for (const k of [host, bare, bare.split('.')[0], s.name, displayNames[host]]) if (k) map.set(norm(k), host);
  }
  return map;
}

const SEGMENT_SPLIT = /[;\n]+/;
const HEAD = /^([^:]{2,40}):\s*(.*)$/;
const PAGE_LABEL = /^(.*?)\s+(mobile|desktop)\b/i;
const PAIR = /(mobile|desktop)\s*:?\s*(?:before\s*)?(\d+)\s*(?:>|->|→|to)\s*(?:after\s*)?(\d+)/gi;

/**
 * Parses the compact text form. Accepts "Mobile 68>74", "Mobile 68 -> 74" and "Mobile Before 68 -> After 74".
 * A line or segment starting with a known site label and a colon ("AudioConnexion: Homepage ...") switches the
 * site; the pages that follow belong to it until the next site label.
 * @returns {{ byHost: Object, shared: Object|null }} raw page objects (arrays of [before, after])
 */
export function parseScoreText(text, aliases = new Map()) {
  const byHost = {};
  const shared = {};
  let current = null;
  for (let chunk of text.split(SEGMENT_SPLIT).map((x) => x.trim()).filter(Boolean)) {
    const head = chunk.match(HEAD);
    if (head && aliases.has(norm(head[1]))) {
      current = aliases.get(norm(head[1]));
      chunk = head[2].trim();
      if (!chunk) continue;
    }
    const m = chunk.match(PAGE_LABEL);
    if (!m) throw new Error(`Cannot read page name in score text: "${chunk}"`);
    const label = m[1].replace(/[:,-]\s*$/, '').trim();
    const target = current ? (byHost[current] ??= {}) : shared;
    const page = (target[label] ??= {});
    for (const mm of chunk.slice(m[1].length).matchAll(PAIR)) page[mm[1].toLowerCase()] = [Number(mm[2]), Number(mm[3])];
    if (!Object.keys(page).length) throw new Error(`No scores found for page "${label}" in: "${chunk}"`);
  }
  return { byHost, shared: Object.keys(shared).length ? shared : null };
}

/**
 * @param {string|Object|null} input JSON string, compact text, or object
 * @param {{ aliases?: Map<string,string> }} [opts] site label lookup (see siteAliases) for per-site text lines
 * @returns {{ byHost: Object<string,Object>, shared: Object|null }} scores keyed by hostname, plus un-keyed scores
 */
export function parseScores(input, opts = {}) {
  if (input == null || input === '') return { byHost: {}, shared: null };
  let obj = input;
  if (typeof input === 'string') {
    const t = input.trim();
    if (!t.startsWith('{')) {
      const raw = parseScoreText(t, opts.aliases);
      const byHost = Object.fromEntries(Object.entries(raw.byHost).map(([h, pages]) => [h, normalizePages(pages, h)]));
      return { byHost, shared: raw.shared ? normalizePages(raw.shared) : null };
    }
    obj = JSON.parse(t);
  }
  const byHost = {};
  const rest = {};
  for (const [k, v] of Object.entries(obj)) {
    if (looksLikeHost(k) && v && typeof v === 'object' && !('mobile' in v) && !('desktop' in v)) byHost[k] = normalizePages(v, k);
    else rest[k] = v;
  }
  return { byHost, shared: Object.keys(rest).length ? normalizePages(rest) : null };
}

/** Scores that apply to one hostname (per-host block wins over shared). */
export function scoresForHost(parsed, hostname) {
  return parsed.byHost[hostname] ?? parsed.byHost[hostname.replace(/^www\./, '')] ?? parsed.shared ?? null;
}

const isAbout = (key) => /about/.test(key);

/**
 * Adapter to the legacy shape the existing generators read:
 *   { desktop:{before:{performance},after:{performance}}, mobile:{...}, aboutUs?:{desktop:{before,after},mobile:{...}} }
 * First non-"about" page (homepage preferred) drives the headline scorecards; the about page feeds the About Us slide.
 * Accessibility / best-practices / SEO are intentionally omitted so generators use the measured Lighthouse values.
 */
export function toLegacyScores(pages) {
  if (!pages) return null;
  const keys = Object.keys(pages);
  const primaryKey = keys.includes('homepage') ? 'homepage' : keys.find((k) => !isAbout(k)) ?? keys[0];
  const aboutKey = keys.find((k) => isAbout(k) && k !== primaryKey);
  const legacy = {};
  for (const vp of ['desktop', 'mobile']) {
    const p = pages[primaryKey]?.[vp];
    if (p) legacy[vp] = { before: { performance: p.before }, after: { performance: p.after } };
  }
  if (aboutKey) {
    legacy.aboutUs = {};
    for (const vp of ['desktop', 'mobile']) if (pages[aboutKey][vp]) legacy.aboutUs[vp] = { ...pages[aboutKey][vp] };
  }
  return legacy;
}

/** Flat list [{ page, label, viewport, before, after, delta }] for reports and history. */
export function flattenScores(pages) {
  if (!pages) return [];
  return Object.entries(pages).flatMap(([page, p]) => ['mobile', 'desktop'].filter((vp) => p[vp]).map((vp) => ({
    page, label: p.label ?? page, viewport: vp, before: p[vp].before, after: p[vp].after, delta: p[vp].after - p[vp].before
  })));
}
