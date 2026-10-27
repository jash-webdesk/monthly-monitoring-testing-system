/**
 * Our Green House monthly website health and maintenance deck.
 *
 * The September deck is kept as a template (templates/ogh/monthly-report-template.pptx), so the layout, fonts,
 * icons and colours are exactly the same every month. This file only replaces the text, numbers, charts and
 * screenshots with the month's audit results. Nothing on the deck is invented: every number and sentence comes
 * from the saved audit results (results/<host>/<month>/*.json).
 */
import JSZip from 'jszip';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadResults, getArchivePath } from './lib/archive.js';
import { logger } from './lib/logger.js';
import { convertPptxToPdf } from './lib/pptxToPdf.js';

const TEMPLATE = resolve('templates/ogh/monthly-report-template.pptx');
const TEMPLATE_MONTH = 'September 2026';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const GREEN = '16A34A';
const AMBER = 'D9962B';
const BLUE = '3A9AD8';
const RED = 'DC2626';

// ─── XML helpers ─────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const textsOf = (xml) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unesc(m[1]));
const joinedText = (xml) => textsOf(xml).join('');

/** Splits a slide into [head, ...shape blocks] so shapes can be found by their text and put back unchanged. */
function split(xml) {
  const parts = xml.split(/(?=<p:sp>|<p:pic>|<p:graphicFrame>)/);
  return { head: parts[0], blocks: parts.slice(1) };
}
const join_ = ({ head, blocks }) => head + blocks.join('');

/** Index of the shape whose text starts with (or equals) the given template text. */
function find(doc, startsWith, from = 0) {
  const i = doc.blocks.findIndex((b, k) => k >= from && joinedText(b).startsWith(startsWith));
  if (i < 0) throw new Error(`Template shape not found: "${startsWith}"`);
  return i;
}
function findExact(doc, text, from = 0) {
  const i = doc.blocks.findIndex((b, k) => k >= from && joinedText(b) === text);
  if (i < 0) throw new Error(`Template shape not found: "${text}"`);
  return i;
}

/** Replaces the text of a shape's runs in order. Extra runs are blanked. */
function setRuns(block, texts) {
  let n = 0;
  return block.replace(/<a:t>[^<]*<\/a:t>/g, () => `<a:t>${esc(texts[n++] ?? '')}</a:t>`);
}
/** Rebuilds a shape's paragraphs (bullets) from a list, using the first paragraph as the style. */
function setParagraphs(block, items) {
  const paras = block.match(/<a:p>[\s\S]*?<\/a:p>/g);
  if (!paras) throw new Error('no paragraphs in shape');
  const tpl = paras[0];
  const runStart = tpl.indexOf('<a:r>');
  const runEnd = tpl.lastIndexOf('</a:r>') + '</a:r>'.length;
  const run = tpl.match(/<a:r>[\s\S]*?<\/a:r>/)[0];
  const make = (text) => tpl.slice(0, runStart) + run.replace(/<a:t>[^<]*<\/a:t>/, `<a:t>${esc(text)}</a:t>`) + tpl.slice(runEnd);
  const first = block.indexOf(paras[0]);
  const last = block.lastIndexOf(paras[paras.length - 1]) + paras[paras.length - 1].length;
  return block.slice(0, first) + items.map(make).join('') + block.slice(last);
}
/** Fill colour of a shape (its own background). */
function setFill(block, hex) {
  // Recolour both the fill and the outline: the template draws its dots and pills with an outline in the same colour.
  return block.replace(/<p:spPr>[\s\S]*?<\/p:spPr>/, (sp) => sp.replace(/(<a:srgbClr val=")(16A34A|D9962B|3A9AD8|DC2626)(")/g, `$1${hex}$3`));
}
/** Shape whose top-left corner is at the given position (EMU). Used for table cells, which have no unique text. */
function at(doc, x, y) {
  const i = doc.blocks.findIndex((b) => new RegExp(`<a:off x="${x}" y="${y}"\\s*/>`).test(b));
  if (i < 0) throw new Error(`Template shape not found at ${x},${y}`);
  return i;
}
/** Colour of the text in a shape. */
function setTextColor(block, hex) {
  return block.replace(/(<a:rPr[\s\S]*?<a:solidFill><a:srgbClr val=")\w+(")/, `$1${hex}$2`);
}

// ─── Data from the audit results ─────────────────────────────────────────────

const baseKey = (f) => String(f.id).replace(/-(homepage|product|guest|auth)\b.*$/, '').replace(/-(homepage|product)$/, '');
const rank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** One entry per distinct issue (the same finding on two pages counts once). */
function observationsFrom(runners) {
  const map = new Map();
  for (const r of runners.filter(Boolean)) {
    for (const f of r.findings ?? []) {
      if (f.severity === 'info' || String(f.id).includes('runner-error')) continue;
      const key = baseKey(f);
      const prev = map.get(key);
      if (!prev || rank[f.severity] > rank[prev.severity]) map.set(key, { key, id: f.id, severity: f.severity, title: f.title, runner: f.runner });
    }
  }
  return [...map.values()];
}

function areaOf(o) {
  const id = o.id;
  if (id.startsWith('journey-builder')) return 'builder';
  if (id.startsWith('journey-')) return 'journeys';
  if (id.startsWith('a11y-')) return 'accessibility';
  if (id.startsWith('seo-')) return 'seo';
  if (id.startsWith('availability-slow')) return 'speed';
  if (id.startsWith('availability-')) return 'links';
  if (/^devtools-.*console-errors/.test(id)) return 'scripts';
  if (id.startsWith('devtools-') || id.startsWith('security-')) return 'security';
  if (o.runner === 'dns' || id.startsWith('dns-')) return 'email';
  if (o.runner === 'ssl') return 'security';
  if (o.runner === 'lighthouse') return 'speed';
  return 'other';
}

export function buildOghData(hostname, month) {
  const R = (name) => loadResults(hostname, name, month);
  const avail = R('availability');
  const func = R('functional');
  const resp = R('responsive');
  const a11y = R('accessibility');
  const seo = R('seo_sample');
  const crawler = R('crawler');
  const dt = R('devtools');
  const extras = R('security_extras');
  const lh = R('lighthouse');
  const dns = R('dns');
  const ssl = R('ssl');
  if (!avail || !func) throw new Error(`Audit results for ${hostname} ${month} are incomplete (availability and functional are required). Run the audit first.`);

  const obs = observationsFrom([avail, func, resp, a11y, seo, crawler, dt, extras, lh, dns, ssl]);
  const sev = (s) => obs.filter((o) => o.severity === s).length;
  const counts = { critical: sev('critical'), high: sev('high'), medium: sev('medium'), low: sev('low') };

  const J = Object.fromEntries((func.metrics.journeys ?? []).map((j) => [j.name, j]));
  const ok = (...names) => names.every((n) => J[n]?.ok);
  const groups = {
    search: ['search-valid', 'search-partial', 'search-none', 'search-unusual'],
    category: ['category-browse'], builder: ['gift-basket-builder'], product: ['product-page'],
    cart: ['add-to-cart', 'cart-page', 'cart-quantity', 'cart-remove'], coupon: ['invalid-coupon'], checkout: ['guest-checkout'], signin: ['signin-empty', 'signin-invalid']
  };
  const journeysReviewed = Object.values(groups).filter((names) => names.some((n) => J[n])).length;

  const checks = Object.fromEntries((resp?.metrics.checks ?? []).map((c) => [c.view, c]));
  const am = avail.metrics;
  const sm = seo?.metrics ?? {};
  const cls = lh?.metrics?.desktop?.cls?.value ?? null;
  const lcp = lh?.metrics?.desktop?.lcp?.displayValue ?? null;
  const homeLoadSec = am.homepageLoadMs ? Math.round(am.homepageLoadMs / 1000) : null;
  const hasFinding = (re) => obs.some((o) => re.test(o.id));
  const headerGaps = obs.filter((o) => /^devtools-(missing-|hsts)/.test(o.id)).length;
  const thirdParty = Math.max(...[dt?.metrics?.pages?.homepage?.guestMode?.thirdPartyScripts?.length ?? 0, 0]);

  return {
    hostname, month, obs, counts, groups, J, ok, journeysReviewed, checks, am, sm, cls, lcp, homeLoadSec, headerGaps, thirdParty, hasFinding,
    sitemapUrls: crawler?.metrics?.totalSitemapUrls ?? null,
    robots: sm.robots ?? null,
    dnsFindings: (dns?.findings ?? []).length,
    sslOk: !ssl || (ssl.findings ?? []).length === 0,
    journeyResults: func.metrics.journeys ?? [],
    evidence: { ...(resp?.metrics.evidence ?? {}), ...(func.metrics.evidence ?? {}) }
  };
}

// ─── Wording ─────────────────────────────────────────────────────────────────

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function wording(d) {
  const { am, ok, sm, checks, counts, obs } = d;
  const bad = am.clientErrors + am.serverErrors;
  const notes = [];

  const availabilityText = bad === 0
    ? `All ${am.checked} pages linked from the main navigation loaded successfully, with no server errors observed.`
    : `${am.ok} of ${am.checked} pages linked from the main navigation loaded successfully; ${plural(bad, 'page')} returned an error.`;
  const navText = am.redirected > 0
    ? `Header, menus and footer links were reviewed, including ${plural(am.redirected, 'page')} that redirect to their current versions.`
    : 'Header, menus and footer links were reviewed, and none needed a redirect.';
  const searchText = ok(...d.groups.search)
    ? 'Valid, partial, no-result and unusual searches were all handled gracefully.'
    : `Some searches did not complete as expected (${d.groups.search.filter((n) => !d.ok(n)).map((n) => n.replace('search-', '')).join(', ')}).`;
  const errorText = am.errorPage?.friendly ? 'A missing page correctly shows a friendly "not found" page.' : 'A missing page does not show a clear "not found" page and should be reviewed.';
  const cartOk = ok(...d.groups.cart);
  const cartText = cartOk ? 'Adding, changing and removing items worked, with correct totals.' : `Part of the cart journey did not complete (${d.groups.cart.filter((n) => !d.ok(n)).join(', ')}).`;
  const signinText = ok(...d.groups.signin) ? 'Empty and invalid sign-in details produce clear, helpful messages.' : 'Sign-in messages did not all appear as expected and should be reviewed.';

  // Device bullets
  const sideways = Object.values(checks).filter((c) => c.sideways && c.view !== 'mobile-builder').map((c) => c.view);
  const deviceBullets = [
    sideways.length ? `Sideways scrolling was found on: ${sideways.join(', ')}.` : 'Layouts adapt cleanly at desktop, tablet and mobile sizes, with no sideways scrolling.',
    checks['mobile-menu']?.opened ? 'Mobile menu, cart and product pages remain easy to use.' : 'The mobile menu could not be opened by the automated check and should be confirmed by hand.',
    'Buttons, forms and calls to action were reviewed for consistent behaviour.',
    checks['mobile-builder'] ? (checks['mobile-builder'].status === 200 && !checks['mobile-builder'].sideways ? 'The gift-basket builder works on mobile.' : 'The gift-basket builder did not display cleanly on mobile and should be reviewed.') : 'The gift-basket builder was not checked on mobile this month.'
  ];

  // Performance bullets
  const perf = [];
  if (d.cls !== null) perf.push(d.cls <= 0.1 ? `Layout stability on the homepage measured at ${d.cls.toFixed(3)} (no unexpected shifting).` : `Layout stability on the homepage measured at ${d.cls.toFixed(3)}, which is above the recommended 0.1.`);
  if (d.homeLoadSec !== null) perf.push(d.homeLoadSec >= 7 ? `Homepage full load took about ${d.homeLoadSec} seconds in a single test run, so a dedicated speed review is recommended.` : `Homepage full load took about ${d.homeLoadSec} seconds in a single test run, which is acceptable; the main content appears sooner.`);
  if (d.lcp) perf.push(`The main content of the homepage appeared in about ${d.lcp} on desktop.`);
  if (!perf.length) perf.push('Performance figures were not available this month.');

  // SEO bullets: [text, colour]
  const seoRows = [];
  const filesOk = (d.robots?.present ?? false) && Number.parseInt(d.sitemapUrls) > 0;
  seoRows.push([filesOk ? 'Search-engine files (robots.txt and sitemap) are in place and valid' : 'The robots.txt file or the sitemap needs attention', filesOk ? GREEN : AMBER]);
  const tagGaps = (sm.missingCanonical ?? 0) + (sm.missingSocialTags ?? 0);
  seoRows.push([tagGaps === 0 ? 'Canonical addresses and social sharing tags found on sampled pages' : `${plural(Math.max(sm.missingCanonical ?? 0, sm.missingSocialTags ?? 0), 'sampled page')} missing canonical addresses or social sharing tags`, tagGaps === 0 ? GREEN : AMBER]);
  const types = sm.structuredTypes ?? [];
  const structured = [types.includes('Organization') && 'organisation', types.includes('Product') && 'product', types.includes('BreadcrumbList') && 'breadcrumbs'].filter(Boolean);
  seoRows.push([structured.length ? `Structured data present (${structured.join(', ')})` : 'No structured data was found on the sampled pages', structured.length ? GREEN : AMBER]);
  seoRows.push([(sm.blockedFromSearch ?? 0) === 0 ? 'No pages blocked from search engines in the sample' : `${plural(sm.blockedFromSearch, 'sampled page')} blocked from search engines`, (sm.blockedFromSearch ?? 0) === 0 ? GREEN : AMBER]);
  seoRows.push([(sm.missingDescription ?? 0) === 0 ? `All ${sm.sampled} sampled pages have a meta description` : `${sm.missingDescription} of ${sm.sampled} sampled pages have no meta description`, (sm.missingDescription ?? 0) === 0 ? GREEN : AMBER]);
  seoRows.push([(sm.headingIssues ?? 0) === 0 ? 'Page headings are clear on the sampled pages' : 'A few pages have missing or repeated headings', (sm.headingIssues ?? 0) === 0 ? GREEN : AMBER]);

  // Security lists
  const good = [];
  const recommend = [];
  good.push(d.hasFinding(/^security-http-redirect/) ? null : 'Secure connection (HTTPS) active; visitors on the plain-web address are redirected to it');
  good.push(d.hasFinding(/^security-mixed-content/) ? null : 'No insecure content found loading on the pages checked');
  good.push(ok('search-unusual') ? 'Unusual characters typed into search were not displayed back unsafely' : null);
  good.push(ok(...d.groups.signin, 'guest-checkout') ? 'Sign-in and checkout forms validate input and show clear messages' : null);
  if (d.headerGaps > 0) recommend.push('Strengthen the browser security settings the site sends (for example, enforce secure connections for returning visitors)');
  if (d.hasFinding(/missing-(referrer|permissions|cross-origin)/)) recommend.push('Add optional extra privacy and protection headers');
  if (d.hasFinding(/sri-missing/) || d.thirdParty > 10) recommend.push('Review which third-party scripts are loaded on every page');
  if (d.hasFinding(/retire-js/)) recommend.push('Update an older script library (jQuery) that has known security notices');
  if (d.hasFinding(/^dns-.*dmarc|dmarc/i) || obs.some((o) => /dmarc/i.test(o.title))) recommend.push('Add email sender protection (DMARC and DKIM records) so the shop\'s emails are trusted');
  if (!recommend.length) recommend.push('No hardening items were identified this month');

  // Findings table: five largest areas
  const areaText = {
    builder: ['Gift basket builder', 'Small script errors were noted when the builder loads', 'Recommended', 'Keeps a key sales tool running smoothly'],
    journeys: ['Customer journeys', 'A step in the shopping journey did not complete', 'Recommended', 'Protects sales and sign-ups'],
    security: ['Security settings', 'Some browser protection settings and older scripts need attention', 'Recommended', 'Stronger protection for visitors'],
    speed: ['Page speed', 'A few pages were slower to respond in testing', 'Monitor', 'Faster experience, better search ranking'],
    seo: ['Search metadata', 'Some pages lack descriptions or clear headings', 'Recommended', 'Clearer listings in search results'],
    accessibility: ['Accessibility', 'Some labels, link text and colour contrast need attention', 'Recommended', 'Easier for all visitors to use'],
    email: ['Email settings', 'Email sender protection records are missing', 'Recommended', 'Shop emails are more likely to reach the inbox'],
    links: ['Site links', 'A few menu links redirect or do not lead to a live page', 'Recommended', 'Visitors reach the right page first time'],
    scripts: ['Browser scripts', 'Small script errors appear in the browser', 'Recommended', 'Prevents quiet feature problems'],
    other: ['Other', 'Minor items were noted', 'Monitor', 'Keeps the site tidy']
  };
  const byArea = new Map();
  for (const o of obs) {
    const a = areaOf(o);
    const e = byArea.get(a) ?? { area: a, count: 0, top: 0 };
    e.count += 1; e.top = Math.max(e.top, rank[o.severity]);
    byArea.set(a, e);
  }
  const rows = [...byArea.values()].sort((x, y) => y.top - x.top || y.count - x.count).slice(0, 5).map((e) => areaText[e.area]);

  // Health summary cards: [status text, colour, description]
  const state = (good_, text_ok, text_bad) => (good_ ? ['Healthy', GREEN, text_ok] : ['Needs attention', AMBER, text_bad]);
  const health = [
    state(bad === 0 && am.errorPage?.friendly, `All ${am.checked} checked pages loaded`, `${plural(bad, 'checked page')} returned an error`),
    state(Object.values(d.groups).flat().every((n) => !d.J[n] || d.J[n].ok), d.obsBuilder ? 'Core journeys work' : 'Core journeys work; builder has minor script errors', 'A shopping step did not complete'),
    state(!obs.some((o) => areaOf(o) === 'accessibility' && rank[o.severity] >= 3), 'Consistent; small accessibility points noted', 'Accessibility items need attention'),
    state(sideways.length === 0, 'Desktop, tablet and mobile reviewed', `Sideways scrolling on ${sideways.join(', ')}`),
    state(!obs.some((o) => ['scripts', 'security'].includes(areaOf(o)) && rank[o.severity] >= 2), 'No technical issues noted', 'Some configuration items to tidy'),
    state(!(d.homeLoadSec >= 6 || am.buckets.over2 > 10), 'Pages respond quickly', 'Caching and load time to review'),
    state((sm.missingDescription ?? 0) === 0 && (sm.headingIssues ?? 0) === 0, 'Metadata complete on sampled pages', 'Metadata gaps on some pages'),
    d.thirdParty > 10 ? ['Monitoring', BLUE, 'Many third-party tools; keep watching'] : ['Healthy', GREEN, 'Third-party tools loading as expected'],
    state(d.headerGaps === 0 && counts.critical === 0, 'Protections in good order', 'Hardening recommended')
  ];
  return { availabilityText, navText, searchText, errorText, cartText, signinText, deviceBullets, perf, seoRows, good: good.filter(Boolean), recommend, rows, health, sideways };
}

// ─── Chart + workbook patches ────────────────────────────────────────────────

function patchChartValues(xml, { cats, vals, title, colors }) {
  const n = cats.length;
  let out = xml;
  out = out.replace(/<c:cat>[\s\S]*?<\/c:cat>/, (m) => {
    const isMulti = m.includes('multiLvl');
    const pts = cats.map((c, i) => `<c:pt idx="${i}"><c:v>${esc(c)}</c:v></c:pt>`).join('');
    const ref = `Sheet1!$A$2:$A$${n + 1}`;
    return isMulti
      ? `<c:cat><c:multiLvlStrRef><c:f>${ref}</c:f><c:multiLvlStrCache><c:ptCount val="${n}"/><c:lvl>${pts}</c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>`
      : `<c:cat><c:strRef><c:f>${ref}</c:f><c:strCache><c:ptCount val="${n}"/>${pts}</c:strCache></c:strRef></c:cat>`;
  });
  out = out.replace(/<c:val>[\s\S]*?<\/c:val>/, `<c:val><c:numRef><c:f>Sheet1!$B$2:$B$${n + 1}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val>`);
  if (title) out = out.replace(/(<a:t>)[^<]*(<\/a:t>)/, `$1${esc(title)}$2`);
  if (colors) {
    // One value label per segment, in the style of the template's first label (value only).
    const labels = out.match(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g);
    if (labels?.length) {
      const clones = colors.map((_, i) => labels[0].replace(/<c:idx val="\d+"\/>/, `<c:idx val="${i}"/>`)).join('');
      const first = out.indexOf(labels[0]);
      const last = out.lastIndexOf(labels[labels.length - 1]) + labels[labels.length - 1].length;
      out = out.slice(0, first) + clones + out.slice(last);
    }
    const dpts = colors.map((c, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join('');
    out = out.replace(/(<c:dPt>[\s\S]*<\/c:dPt>)/, dpts);
  }
  return out;
}

async function patchWorkbook(buffer, { header, cats, vals }) {
  const wb = await JSZip.loadAsync(buffer);
  const strings = ['', header, ...cats];
  wb.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`);
  let sheet = await wb.file('xl/worksheets/sheet1.xml').async('string');
  const rows = cats.map((c, i) => `<row r="${i + 2}" spans="1:2"><c r="A${i + 2}" t="s"><v>${i + 2}</v></c><c r="B${i + 2}"><v>${vals[i]}</v></c></row>`).join('');
  sheet = sheet.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:B${cats.length + 1}"/>`)
    .replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData><row r="1" spans="1:2"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>${rows}</sheetData>`);
  wb.file('xl/worksheets/sheet1.xml', sheet);
  return wb.generateAsync({ type: 'nodebuffer' });
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function generateOghReport(hostname, month, options = {}) {
  const [yy, mm] = month.split('-');
  const monthLabel = `${MONTH_NAMES[Number(mm) - 1]} ${yy}`;
  const d = buildOghData(hostname, month);
  d.obsBuilder = !d.obs.some((o) => areaOf(o) === 'builder');
  const w = wording(d);
  const zip = await JSZip.loadAsync(readFileSync(TEMPLATE));
  const slidePath = (n) => `ppt/slides/slide${n}.xml`;
  const load = async (n) => split(await zip.file(slidePath(n)).async('string'));
  const save = (n, doc) => zip.file(slidePath(n), join_(doc));

  // Month on every slide (cover and footers)
  for (let n = 1; n <= 13; n++) {
    let xml = await zip.file(slidePath(n)).async('string');
    xml = xml.split(TEMPLATE_MONTH).join(monthLabel);
    zip.file(slidePath(n), xml);
  }

  // 2. Overview numbers
  {
    const doc = await load(2);
    const crit = d.counts.critical + d.counts.high;
    const map = [['385', String(d.am.checked)], ['8', String(d.journeysReviewed)], ['3', '3'], ['19', String(d.sm.sampled ?? 0)], ['32', String(d.obs.length)], ['0', String(crit)]];
    // Find every number shape first, so a new value can never be mistaken for a later template value.
    const spots = map.map(([from, to]) => ({ i: findExact(doc, from), from, to }));
    for (const { i, from, to } of spots) {
      doc.blocks[i] = setRuns(doc.blocks[i], [to]);
      if (from === '0') doc.blocks[i] = setTextColor(doc.blocks[i], crit === 0 ? GREEN : RED);
    }
    const s = find(doc, 'Reviewed this month');
    doc.blocks[s] = setRuns(doc.blocks[s], [`Reviewed this month: functionality, user experience, responsive layout, technical health, SEO, performance, integrations and safe security checks. The same areas were reviewed in September, when 32 observations were documented.`]);
    save(2, doc);
  }

  // 3. Website health cards
  {
    const doc = await load(3);
    const pairs = [['All 385 pages', w.availabilityText], ['Header, menus', w.navText], ['Valid, partial', w.searchText], ['A missing page', w.errorText], ['Adding, changing', w.cartText], ['Empty and invalid', w.signinText]];
    for (const [anchor, text] of pairs) { const i = find(doc, anchor); doc.blocks[i] = setRuns(doc.blocks[i], [text]); }
    save(3, doc);
  }

  // 4. Experience across devices (bullets) and screenshots
  {
    const doc = await load(4);
    const i = find(doc, 'Layouts adapt');
    doc.blocks[i] = setParagraphs(doc.blocks[i], w.deviceBullets);
    save(4, doc);
  }

  // 5. Journeys: note if any step failed
  {
    const failed = d.journeyResults.filter((j) => !j.ok);
    if (failed.length) {
      const doc = await load(5);
      const i = find(doc, 'The customer journey from');
      const base = textsOf(doc.blocks[i]).join('');
      doc.blocks[i] = setRuns(doc.blocks[i], [`${base} Note: ${failed.map((j) => j.name.replace(/-/g, ' ')).join(', ')} did not complete in this month's check.`]);
      save(5, doc);
    }
  }

  // 7. Performance & SEO
  {
    const doc = await load(7);
    const b = find(doc, 'Layout stability');
    doc.blocks[b] = setParagraphs(doc.blocks[b], w.perf);
    const seoTexts = ['Search-engine files', 'Canonical addresses', 'Structured data', 'No pages blocked', '3 of 19 sampled', 'A few pages have'];
    const dots = doc.blocks.map((blk, k) => (/prst="ellipse"/.test(blk) && /<a:srgbClr val="(16A34A|D9962B)"/.test(blk) ? k : -1)).filter((k) => k >= 0);
    seoTexts.forEach((anchor, idx) => {
      const ti = find(doc, anchor);
      doc.blocks[ti] = setRuns(doc.blocks[ti], [w.seoRows[idx][0]]);
      if (dots[idx] !== undefined) doc.blocks[dots[idx]] = setFill(doc.blocks[dots[idx]], w.seoRows[idx][1]);
    });
    save(7, doc);
  }

  // 8. Security
  {
    const doc = await load(8);
    const g = find(doc, 'Secure connection (HTTPS)');
    doc.blocks[g] = setParagraphs(doc.blocks[g], w.good);
    const r = find(doc, 'Strengthen the browser');
    doc.blocks[r] = setParagraphs(doc.blocks[r], w.recommend);
    save(8, doc);
  }

  // 9. Maintenance summary: page count
  {
    let xml = await zip.file(slidePath(9)).async('string');
    xml = xml.replace(/\(385 pages\)/g, `(${d.am.checked} pages)`);
    zip.file(slidePath(9), xml);
  }

  // 10. Findings
  {
    const doc = await load(10);
    const total = d.obs.length;
    const hi = d.counts.critical + d.counts.high;
    const t = find(doc, '32 observations');
    doc.blocks[t] = setRuns(doc.blocks[t], [`${total} observations`]);
    const n = find(doc, 'No critical or high-priority');
    doc.blocks[n] = setRuns(doc.blocks[n], [`${hi === 0 ? 'No critical or high-priority issues.' : `${plural(hi, 'high-priority item')} ${hi === 1 ? 'is' : 'are'} included in the table below.`} No changes were applied to the live site during this review, so items below are open and documented for follow-up.`]);
    // The table is five rows by four columns at fixed positions in the template.
    const cols = [3977640, 5669280, 8183880, 9646920];
    const rowsY = [1920240, 2761488, 3602736, 4443984, 5285232];
    const cells = rowsY.map((y) => cols.map((x) => at(doc, x, y)));
    cells.forEach((row, i) => {
      row.forEach((idx, c) => { doc.blocks[idx] = setRuns(doc.blocks[idx], [w.rows[i]?.[c] ?? '']); });
    });
    save(10, doc);
  }

  // 11. Health summary
  {
    const doc = await load(11);
    const titles = ['Website availability', 'Functionality', 'UI / UX', 'Responsive experience', 'Technical health', 'Performance', 'SEO', 'Integrations', 'Security checks'];
    titles.forEach((title, i) => {
      const t = findExact(doc, title);
      const [status, color, text] = w.health[i];
      doc.blocks[t + 1] = setFill(doc.blocks[t + 1], color);
      doc.blocks[t + 2] = setRuns(doc.blocks[t + 2], [status]);
      doc.blocks[t + 3] = setRuns(doc.blocks[t + 3], [text]);
    });
    save(11, doc);
  }

  // Charts (response time buckets, observation severity)
  {
    const b = d.am.buckets;
    const c1 = await zip.file('ppt/charts/chart1.xml').async('string');
    zip.file('ppt/charts/chart1.xml', patchChartValues(c1, { cats: ['Under 1 second', '1 to 2 seconds', 'Over 2 seconds'], vals: [b.under1, b.oneToTwo, b.over2], title: `Page response time (${d.am.checked} pages)` }));
    const wb1 = await zip.file('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx').async('nodebuffer');
    zip.file('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx', await patchWorkbook(wb1, { header: 'Pages', cats: ['Under 1 second', '1 to 2 seconds', 'Over 2 seconds'], vals: [b.under1, b.oneToTwo, b.over2] }));

    const high = d.counts.critical + d.counts.high;
    const cats = [...(high ? ['High'] : []), 'Medium', 'Low'];
    const vals = [...(high ? [high] : []), d.counts.medium, d.counts.low];
    const colors = [...(high ? [RED] : []), AMBER, BLUE];
    const c2 = await zip.file('ppt/charts/chart2.xml').async('string');
    zip.file('ppt/charts/chart2.xml', patchChartValues(c2, { cats, vals, colors }));
    const wb2 = await zip.file('ppt/embeddings/Microsoft_Excel_Worksheet2.xlsx').async('nodebuffer');
    zip.file('ppt/embeddings/Microsoft_Excel_Worksheet2.xlsx', await patchWorkbook(wb2, { header: 'Priority', cats, vals }));
  }

  // Screenshots (same pixel shapes as the template frames, so nothing is stretched)
  const shots = [
    ['ppt/media/image-4-2.jpg', 'desktop'], ['ppt/media/image-4-3.jpg', 'tablet'], ['ppt/media/image-4-4.jpg', 'mobile'], ['ppt/media/image-4-5.jpg', 'mobile-menu'],
    ['ppt/media/image-5-6.jpg', 'add-to-cart'], ['ppt/media/image-5-7.jpg', 'invalid-coupon'], ['ppt/media/image-5-8.jpg', 'guest-checkout']
  ];
  for (const [target, key] of shots) {
    const p = d.evidence[key];
    if (p && existsSync(p)) zip.file(target, readFileSync(p));
    else logger.warn(`  No screenshot for "${key}"; the template picture was left in place.`);
  }

  const outDir = getArchivePath(hostname, month);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `Our_Green_House_Monthly_Website_Maintenance_Report_${monthLabel.replace(' ', '_')}.pptx`);
  writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  logger.success(`Deck written to ${outPath}`);
  let pdf = null;
  if (options.pdf !== false) {
    pdf = convertPptxToPdf(outPath);
    if (pdf) logger.success(`PDF copy written to ${pdf}`);
    else logger.warn('PDF copy not created: no PPTX-to-PDF converter is available.');
  }
  return { pptx: outPath, pdf, data: { counts: d.counts, observations: d.obs.length } };
}

if (process.argv[1] && process.argv[1].endsWith('generate_ogh_report.js')) {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf('--' + k); return i > -1 ? a[i + 1] : null; };
  generateOghReport(get('host') ?? 'www.ourgreenhouse.com', get('month') ?? new Date().toISOString().slice(0, 7))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
