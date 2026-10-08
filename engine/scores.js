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

/** Parses the compact text form into the object form. */
export function parseScoreText(text) {
  const pages = {};
  for (const chunk of text.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = chunk.match(/^(.*?)\s+(mobile|desktop)\b/i);
    if (!m) throw new Error(`Cannot read page name in score text: "${chunk}"`);
    const label = m[1].replace(/[:,-]\s*$/, '').trim();
    const rest = chunk.slice(m[1].length);
    const page = (pages[label] ??= {});
    for (const mm of rest.matchAll(/(mobile|desktop)\s*:?\s*(\d+)\s*(?:>|->|→|to)\s*(\d+)/gi)) {
      page[mm[1].toLowerCase()] = [Number(mm[2]), Number(mm[3])];
    }
  }
  return pages;
}

/**
 * @param {string|Object|null} input JSON string, compact text, or object
 * @returns {{ byHost: Object<string,Object>, shared: Object|null }} scores keyed by hostname, plus un-keyed scores
 */
export function parseScores(input) {
  if (input == null || input === '') return { byHost: {}, shared: null };
  let obj = input;
  if (typeof input === 'string') {
    const t = input.trim();
    obj = t.startsWith('{') ? JSON.parse(t) : parseScoreText(t);
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
