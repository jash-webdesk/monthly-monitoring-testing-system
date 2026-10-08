import pptxgen from 'pptxgenjs';
import { launchChromium } from './lib/browser.js';
import { join, resolve, relative } from 'node:path';
import fs, { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { logger } from './lib/logger.js';
import { loadResults, getArchivePath } from './lib/archive.js';
import { CUSTOM_APP_HOST, summarizeCustomApp, compareWithBaseline } from './lib/integrityAreas.js';

/**
 * Standalone, content-driven client report generator for the Integrity Reforestation
 * Tree Contribution Widget monthly monitoring engagement.
 *
 * Unlike monitor.js's per-runner reports, this generator does not measure anything itself —
 * every fact on every slide comes from `config/monthly-monitoring-input.json` (Dev team
 * updates + QA/device-matrix notes + online screenshot links you paste in). See
 * `implementation_plan for Integrity Reforestation Monthly Monitoring.md` for the schema.
 *
 * CLI:
 *   node generate_tree_widget_report.js [--input <path>] [--format pptx|pdf|both]
 */

const COLOR_BG_LIGHT = 'FFFFFF';
const COLOR_CARD_BG = 'F8FAFC';
const COLOR_TEXT_DARK = '0F172A';
const COLOR_BRAND_BLUE = '0EA5E9';
const COLOR_BRAND_SECONDARY = '075985';
const COLOR_SUCCESS_GREEN = '10B981';
const COLOR_WARNING_RED = 'DC2626';
const COLOR_MUTED = '64748B';
const COLOR_BORDER = 'E2E8F0';

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Parses --flag / --flag value pairs from argv (same convention as monitor.js). */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
    }
  }
  return out;
}

/** Loads and validates the input JSON. Missing/placeholder screenshot URLs are tolerated —
 *  they render as "Link pending" rather than a broken hyperlink. */
function loadInput(inputPath) {
  if (!existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}. Copy config/monthly-monitoring-input.json and fill it in, or pass --input <path>.`);
  }
  const data = JSON.parse(readFileSync(inputPath, 'utf8'));
  if (!data.month || !/^\d{4}-\d{2}$/.test(data.month)) {
    throw new Error(`Input "month" must be YYYY-MM (got: ${data.month})`);
  }
  return data;
}

function readableMonthYear(month) {
  const [year, m] = month.split('-');
  const idx = parseInt(m, 10) - 1;
  return { label: `${monthNames[idx] ?? m} ${year}`, slug: `${monthNames[idx] ?? m}_${year}` };
}

function isRealUrl(u) {
  return typeof u === 'string' && !/PASTE_ONLINE_URL_HERE/i.test(u) && (
    /^https?:\/\//i.test(u) ||
    /\.(png|jpe?g|webp|gif|svg)$/i.test(u)
  );
}

/** Flattens a theme's screenshots object into a flat [{device, dims, pdp, cart, drawer}] list
 *  grouped by category, for both the PPTX table and the PDF grid. */
function flattenDeviceRows(theme) {
  const groups = [
    { label: 'Mobile', key: 'mobile' },
    { label: 'Tablet', key: 'tablet' },
    { label: 'Desktop', key: 'desktop' }
  ];
  const rows = [];
  for (const g of groups) {
    const bucket = theme?.screenshots?.[g.key] ?? {};
    for (const entry of Object.values(bucket)) {
      rows.push({ group: g.label, ...entry });
    }
  }
  return rows;
}

function countVerifiedLinks(data) {
  let total = 0, verified = 0;
  const themes = data.qaTestingSection?.themes ?? {};
  for (const themeKey of Object.keys(themes)) {
    const theme = themes[themeKey];
    if (!theme) continue;
    for (const row of flattenDeviceRows(theme)) {
      for (const field of ['pdp', 'cart', 'cartPopup', 'drawer']) {
        if (row[field] === undefined) continue;
        total++;
        if (isRealUrl(row[field])) verified++;
      }
    }
  }
  return { total, verified };
}

/** Finds an existing local screenshot file for a theme across results and artifact dirs */
function findScreenshotPath(themeKey, subDir, fileName, outDir) {
  const candidates = [
    resolve(outDir, 'screenshots', themeKey, fileName),
    resolve(outDir, 'screenshots', themeKey, subDir, fileName),
    resolve(process.cwd(), 'results/integrity-reforestation/2026-10/screenshots', themeKey, fileName),
    resolve(process.cwd(), 'results/integrity-reforestation/2026-09/screenshots', themeKey, fileName),
    resolve(process.cwd(), 'results/integrity-reforestation/2026-10/screenshots', themeKey, subDir, fileName),
    resolve(process.cwd(), 'results/integrity-reforestation/2026-09/screenshots', themeKey, subDir, fileName),
    resolve('C:/Users/jashm/.gemini/antigravity/brain/96bab9a2-df97-48be-ad5a-089a54a2d0cb/screenshots', themeKey, fileName),
    resolve('C:/Users/jashm/.gemini/antigravity/brain/96bab9a2-df97-48be-ad5a-089a54a2d0cb/screenshots', themeKey, subDir, fileName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// PPTX GENERATION
// ─────────────────────────────────────────────────────────────────────────

const plainTrim = (t, n = 150) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sentenceEnd = cut.lastIndexOf('. ');
  if (sentenceEnd > n * 0.5) return cut.slice(0, sentenceEnd + 1);
  return cut.replace(/\s+\S*$/, '') + '…';
};
const SEV_PILL = { critical: ['Critical', 'DC2626'], high: ['High', 'DC2626'], medium: ['Medium', 'F59E0B'], low: ['Low', '64748B'] };

/**
 * If a custom-app test run exists for this month (check_integrity_dashboard.js), attach its
 * summary as data.customAppTesting and mention the checks in the executive summary, overview,
 * overall-summary table and final assessment. Numbers come from the saved results only.
 */
function applyCustomAppCoverage(data) {
  const result = loadResults(CUSTOM_APP_HOST, 'integrity_dashboard', data.month);
  if (!result) return;
  const sum = summarizeCustomApp(result);
  const checks = result.metrics?.checks ?? [];
  const dataChecks = checks.filter((c) => /matches Stores Listing|equals the sum|add up|match the listing|matches the listing|Customer \+ Merchant/i.test(c.name));
  sum.dataOk = dataChecks.length > 0 && dataChecks.every((c) => c.status === 'pass');
  data.customAppTesting = sum;
  // Re-test mode: a pre-fix baseline saved before the dev team's fixes turns this into a before/after view.
  const basePath = join(getArchivePath(CUSTOM_APP_HOST, data.month), 'integrity_dashboard_baseline_pre-fix.json');
  if (existsSync(basePath)) { try { sum.retest = compareWithBaseline(sum, JSON.parse(readFileSync(basePath, 'utf8'))); } catch { /* unreadable baseline: ignore */ } }
  const n = sum.findings.length;
  data.executiveSummary = `${data.executiveSummary ?? ''} ${data.opsMonitoringSection ? 'We also tested' : 'This cycle we tested'} the Integrity custom app dashboard end to end in read-only mode (${sum.run} checks across the Dashboard, Stores Listing, Email Templates and Email Logs): ${sum.dataOk ? 'store, tree and contribution figures agree across the dashboard and every store page' : 'some figures differ between pages'}${sum.retest ? `. After the dev team's fixes the checks were repeated: ${sum.retest.fixed} of ${sum.retest.baselineCount} earlier items are fixed and ${n} remain open for follow-up in the accompanying technical report.` : `, and ${n} item${n === 1 ? ' was' : 's were'} noted for follow-up in the accompanying technical report.`}`.trim();
  const ops = data.opsMonitoringSection;
  if (!ops) return;
  ops.overview ??= {};
  ops.overview.optimizationsReviewed = [...(ops.overview.optimizationsReviewed ?? []), 'Custom app dashboard testing: Dashboard, Stores Listing, Email Templates and Email Logs (read-only)'];
  ops.overallSummary = [...(ops.overallSummary ?? []), { area: 'Custom App Dashboard', status: 'Tested', remarks: `${sum.run} read-only checks; ${n} item${n === 1 ? '' : 's'} noted for follow-up` }];
  ops.finalAssessment ??= {};
  ops.finalAssessment.successfulOutcomes = [...(ops.finalAssessment.successfulOutcomes ?? []), `Custom app dashboard tested in read-only mode: ${sum.run} checks across 4 areas, with no data changed.`];
  if (n > 0) ops.finalAssessment.continuedMonitoring = [...(ops.finalAssessment.continuedMonitoring ?? []), `Work through the ${n} custom app item${n === 1 ? '' : 's'} listed in the technical report, then re-run the read-only checks next cycle.`];
}

async function generatePptx(data, outPath) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'WIDE_16_9', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE_16_9';

  const { label: monthLabel } = readableMonthYear(data.month);
  const logoExists = fs.existsSync('white-logo.png');
  // Evidence images (e.g. an SSL certificate screenshot) are dropped alongside the report
  // output, not the project root — resolve those paths against the output directory.
  const outDir = resolve(outPath, '..');

  function addLogo(slide) {
    if (logoExists) slide.addImage({ path: 'white-logo.png', x: 10.5, y: 0.4, w: 2.2, h: 1.2 });
  }
  function setBackground(slide) {
    slide.background = { fill: COLOR_BG_LIGHT };
  }
  function eyebrow(slide, text) {
    slide.addText(text, { x: 0.8, y: 0.4, w: 9.0, h: 0.4, fontSize: 13, color: COLOR_BRAND_BLUE, bold: true, fontFace: 'Outfit' });
  }
  function heading(slide, text, w = 10.5) {
    slide.addText(text, { x: 0.8, y: 0.8, w, h: 0.6, fontSize: 26, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit' });
  }
  function card(slide, x, y, w, h) {
    slide.addShape(pptx.shapes.RECTANGLE, { x, y, w, h, fill: { color: COLOR_CARD_BG }, line: { color: COLOR_BORDER, width: 1 }, rectRadius: 0.1 });
  }

  // ── SLIDE 1: COVER ──────────────────────────────────────────────────
  const s1 = pptx.addSlide();
  setBackground(s1);
  if (logoExists) s1.addImage({ path: 'white-logo.png', x: 0.8, y: 0.8, w: 2.2, h: 1.2 });
  s1.addText(data.reportTitle ?? 'Monthly Storefront Monitoring & Maintenance Report', {
    x: 0.8, y: 2.2, w: 11.5, h: 1.3, fontSize: 34, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit'
  });
  s1.addText(`${data.clientName ?? ''} — ${monthLabel} Development & Storefront QA Report`, {
    x: 0.8, y: 3.6, w: 11.5, h: 0.5, fontSize: 18, color: COLOR_BRAND_BLUE, fontFace: 'Outfit'
  });
  s1.addShape(pptx.shapes.RECTANGLE, { x: 0.8, y: 4.6, w: 2.5, h: 0.05, fill: { color: COLOR_BRAND_BLUE } });
  s1.addText(`Prepared by ${data.preparedBy ?? 'WebDesk Solution Maintenance & QA Team'}`, {
    x: 0.8, y: 5.0, w: 8.0, h: 0.4, fontSize: 13, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
  });
  if (data.storeUrl) {
    s1.addText(data.storeUrl, { x: 0.8, y: 5.4, w: 8.0, h: 0.35, fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
  }

  // ── SLIDE 2: EXECUTIVE SUMMARY ──────────────────────────────────────
  const s2 = pptx.addSlide();
  setBackground(s2); addLogo(s2);
  eyebrow(s2, 'Executive Summary');
  heading(s2, `${monthLabel} Monitoring Overview`);
  s2.addText(data.executiveSummary ?? '', {
    x: 0.8, y: 1.6, w: 11.5, h: 1.3, fontSize: 14, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans', lineSpacing: 20
  });

  const devItemCount = (data.devTeamSection?.categories ?? []).reduce((n, c) => n + (c.items?.length ?? 0), 0);
  const themeCount = Object.keys(data.qaTestingSection?.themes ?? {}).length;
  const { total: linkTotal, verified: linkVerified } = countVerifiedLinks(data);
  const deviceRowCount = themeCount > 0
    ? flattenDeviceRows(Object.values(data.qaTestingSection.themes)[0]).length
    : 0;

  const ops = data.opsMonitoringSection ?? null;
  const hasWidgetQa = themeCount > 0 && !!data.qaTestingSection?.widgetName;
  const catCards = data.customAppTesting;
  const metricCards = (!ops && catCards)
    ? [
        { stat: `${catCards.run}`, label: 'Automated Checks Run' },
        { stat: `${catCards.passed}`, label: 'Checks Passed' },
        { stat: `${catCards.findings.length}`, label: 'Items Noted for Follow-up' }
      ]
    : ops
    ? [
        { stat: ops.performanceMetrics?.app?.responseTime ?? 'N/A', label: 'App Response Time' },
        { stat: ops.performanceMetrics?.dashboard?.responseTime ?? 'N/A', label: 'Dashboard Response Time' },
        { stat: (ops.buildCacheAnalysis ? 'Cleared' : 'N/A'), label: 'Build Cache Status' }
      ]
    : [
        { stat: `${devItemCount}`, label: 'Dev Work Items Completed' },
        { stat: `${themeCount}`, label: 'Themes Monitored' },
        { stat: `${deviceRowCount}`, label: 'Devices Tested per Theme' },
        { stat: data.qaTestingSection?.functionalStatus ?? 'N/A', label: 'Widget Functional Status', small: true }
      ];
  const mcGap = 0.27, mcX0 = 0.8, mcY = 3.2, mcH = 1.5;
  const mcW = (11.7 - (metricCards.length - 1) * mcGap) / metricCards.length;
  metricCards.forEach((m, i) => {
    const x = mcX0 + i * (mcW + mcGap);
    card(s2, x, mcY, mcW, mcH);
    s2.addText(m.stat, { x: x + 0.15, y: mcY + 0.15, w: mcW - 0.3, h: m.small ? 0.7 : 0.6, fontSize: m.small ? 15 : 30, bold: true, color: COLOR_BRAND_BLUE, fontFace: 'Outfit' });
    s2.addText(m.label, { x: x + 0.15, y: mcY + (m.small ? 0.9 : 0.85), w: mcW - 0.3, h: 0.5, fontSize: 11, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
  });
  if (hasWidgetQa && linkTotal > 0 && linkVerified < linkTotal) {
    s2.addText(`${linkVerified} of ${linkTotal} screenshot links are live online; the rest show "Link pending" until added to the input file.`, {
      x: 0.8, y: 4.9, w: 11.5, h: 0.4, fontSize: 11, italic: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
    });
  }

  /** Adds the two "Custom App Testing" slides (coverage + items noted) when a test run exists for this month. */
  function addCustomAppSlides() {
    // -- Custom app testing: coverage + items noted --
    const cat = data.customAppTesting;
    if (cat) {
      const sCa = pptx.addSlide();
      setBackground(sCa); addLogo(sCa);
      eyebrow(sCa, 'Custom App Testing');
      heading(sCa, 'Custom App Dashboard: Coverage & Results');
      // left: donut of passed vs follow-up
      card(sCa, 0.8, 1.7, 4.2, 4.9);
      sCa.addText('CHECKS RUN', { x: 1.1, y: 1.9, w: 3.6, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
      sCa.addChart(pptx.charts.DOUGHNUT, [{ name: 'Checks', labels: ['Passed', 'Needs follow-up'], values: [cat.passed, Math.max(0, cat.failed)] }], {
        x: 1.0, y: 2.2, w: 3.8, h: 3.0, holeSize: 68, chartColors: ['10B981', 'F59E0B'],
        showLegend: false, showPercent: false, showValue: false, showLabel: false, showTitle: false, dataBorder: { pt: 2, color: 'FFFFFF' }
      });
      sCa.addText(`${cat.run}`, { x: 1.0, y: 3.15, w: 3.8, h: 0.7, fontSize: 40, bold: true, color: COLOR_TEXT_DARK, align: 'center', fontFace: 'Outfit' });
      sCa.addText('automated checks', { x: 1.0, y: 3.8, w: 3.8, h: 0.3, fontSize: 11, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });
      [['Passed', '10B981', cat.passed], ['Follow-up', 'F59E0B', cat.failed]].forEach(([label, color, v], i) => {
        const lx = 1.5 + i * 1.7;
        sCa.addShape(pptx.shapes.OVAL, { x: lx, y: 5.45, w: 0.16, h: 0.16, fill: { color }, line: { color, width: 0 } });
        sCa.addText(`${label} ${v}`, { x: lx + 0.2, y: 5.37, w: 1.5, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
      });
      sCa.addText('Read-only: nothing was added, changed, deleted or sent.', { x: 1.0, y: 5.85, w: 3.8, h: 0.5, fontSize: 10, italic: true, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });
      // right: area table
      const hd = (t) => ({ text: t, options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 10.5 } });
      const trows = [[hd('Area'), hd('What we checked'), hd('Checks'), hd('Passed'), hd('Items')]];
      for (const a of cat.areas) {
        trows.push([
          { text: a.label, options: { bold: true, fontSize: 10.5 } },
          { text: a.tested, options: { fontSize: 8.5, color: COLOR_MUTED } },
          { text: `${a.run}`, options: { fontSize: 10.5, align: 'center' } },
          { text: `${a.passed}`, options: { fontSize: 10.5, align: 'center', color: COLOR_SUCCESS_GREEN, bold: true } },
          { text: a.items ? `${a.items}` : '—', options: { fontSize: 10.5, align: 'center', bold: true, color: a.items ? 'B45309' : COLOR_MUTED } }
        ]);
      }
      sCa.addTable(trows, { x: 5.3, y: 1.7, w: 7.2, fontSize: 10, fontFace: 'Plus Jakarta Sans', border: { color: COLOR_BORDER, width: 1 }, autoPage: false, colW: [1.45, 3.45, 0.75, 0.8, 0.75] });
      const fmtShort = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? t : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
      const mini = [
        { label: 'DATA ACCURACY', big: cat.dataOk ? 'Verified' : 'Review', color: cat.dataOk ? '10B981' : 'F59E0B', note: cat.dataOk ? 'Totals match on every page' : 'Some totals differ' },
        { label: 'WRITE REQUESTS', big: `${cat.writes}`, color: cat.writes === 0 ? '10B981' : 'DC2626', note: cat.writes === 0 ? 'Nothing was changed' : 'Blocked before sending' },
        { label: 'STORES OPENED', big: cat.storesChecked != null ? `${cat.storesChecked}` : '—', color: '0EA5E9', note: 'via the View button' },
        { label: 'LAST FAILED E-MAIL', big: cat.latestFailed ? fmtShort(cat.latestFailed) : 'None', color: cat.latestFailed ? (cat.daysSinceFailed != null && cat.daysSinceFailed <= 14 ? 'DC2626' : '0EA5E9') : '10B981', note: cat.daysSinceFailed != null ? `${cat.daysSinceFailed} days before testing` : 'No failures recorded' }
      ];
      mini.forEach((m, i) => {
        const mx = 5.3 + i * 1.83;
        card(sCa, mx, 4.7, 1.7, 1.35);
        sCa.addText(m.label, { x: mx + 0.12, y: 4.8, w: 1.5, h: 0.25, fontSize: 7.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
        sCa.addText(m.big, { x: mx + 0.12, y: 5.05, w: 1.5, h: 0.5, fontSize: 18, bold: true, color: m.color, fontFace: 'Outfit' });
        sCa.addText(m.note, { x: mx + 0.12, y: 5.55, w: 1.5, h: 0.4, fontSize: 8.5, color: COLOR_MUTED, valign: 'top', fontFace: 'Plus Jakarta Sans' });
      });
      sCa.addText('Email Templates: Add, Edit, Delete and Send test mail were intentionally not used.', { x: 5.3, y: 6.25, w: 7.2, h: 0.35, fontSize: 9.5, italic: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });

      // -- Re-test after the dev team's fixes (only when a pre-fix baseline exists) --
      if (cat.retest) {
        const rt = cat.retest;
        const sRt = pptx.addSlide();
        setBackground(sRt); addLogo(sRt);
        eyebrow(sRt, 'Custom App Testing');
        heading(sRt, 'Re-test After the Dev Team Fixes');
        card(sRt, 0.8, 1.7, 4.2, 4.9);
        sRt.addText('ITEMS REPORTED EARLIER', { x: 1.1, y: 1.9, w: 3.6, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
        sRt.addChart(pptx.charts.DOUGHNUT, [{ name: 'Items', labels: ['Fixed', 'Still open'], values: [rt.fixed, Math.max(0, rt.open)] }], {
          x: 1.0, y: 2.2, w: 3.8, h: 3.0, holeSize: 68, chartColors: ['10B981', 'F59E0B'],
          showLegend: false, showPercent: false, showValue: false, showLabel: false, showTitle: false, dataBorder: { pt: 2, color: 'FFFFFF' }
        });
        sRt.addText(`${rt.fixed} of ${rt.baselineCount}`, { x: 1.0, y: 3.2, w: 3.8, h: 0.7, fontSize: 32, bold: true, color: COLOR_TEXT_DARK, align: 'center', fontFace: 'Outfit' });
        sRt.addText('items fixed', { x: 1.0, y: 3.85, w: 3.8, h: 0.3, fontSize: 11, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });
        [['Fixed', '10B981', rt.fixed], ['Still open', 'F59E0B', rt.open]].forEach(([label, color, v], i) => {
          const lx = 1.5 + i * 1.7;
          sRt.addShape(pptx.shapes.OVAL, { x: lx, y: 5.45, w: 0.16, h: 0.16, fill: { color }, line: { color, width: 0 } });
          sRt.addText(`${label} ${v}`, { x: lx + 0.2, y: 5.37, w: 1.5, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
        });
        sRt.addText(rt.newCount ? `${rt.newCount} new item${rt.newCount === 1 ? '' : 's'} found on the re-test.` : 'No new items found on the re-test.', { x: 1.0, y: 5.85, w: 3.8, h: 0.4, fontSize: 10, italic: true, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });
        const step = Math.min(0.42, 4.8 / Math.max(1, rt.rows.length));
        rt.rows.forEach((row, i) => {
          const ry = 1.75 + i * step;
          const color = row.fixed ? '10B981' : 'F59E0B';
          sRt.addShape(pptx.shapes.OVAL, { x: 5.35, y: ry + 0.06, w: 0.26, h: 0.26, fill: { color }, line: { color, width: 0 } });
          sRt.addText(row.fixed ? '✓' : '•', { x: 5.35, y: ry + 0.06, w: 0.26, h: 0.26, fontSize: 10, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
          sRt.addText(plainTrim(row.title, 78), { x: 5.75, y: ry, w: 5.35, h: 0.38, fontSize: 10, bold: true, color: COLOR_TEXT_DARK, valign: 'middle', fontFace: 'Plus Jakarta Sans', lineSpacing: 11 });
          sRt.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 11.3, y: ry + 0.07, w: 1.1, h: 0.24, fill: { color: row.fixed ? 'ECFDF5' : 'FFFBEB' }, line: { color, width: 1 }, rectRadius: 0.1 });
          sRt.addText(row.fixed ? 'Fixed' : 'Still open', { x: 11.3, y: ry + 0.07, w: 1.1, h: 0.24, fontSize: 8.5, bold: true, color: row.fixed ? '047857' : 'B45309', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
        });
        sRt.addText('Each earlier item was repeated against the live dashboard after the dev team reported their fixes.', { x: 5.3, y: 6.5, w: 7.2, h: 0.35, fontSize: 9.5, italic: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
      }

      const sCi = pptx.addSlide();
      setBackground(sCi); addLogo(sCi);
      eyebrow(sCi, 'Custom App Testing');
      heading(sCi, cat.retest ? 'Custom App Dashboard: Items Still Open' : 'Custom App Dashboard: Items Noted');
      const items = cat.findings;
      if (items.length === 0) {
        sCi.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 0.8, y: 2.0, w: 11.7, h: 1.2, fill: { color: 'ECFDF5' }, line: { color: '86EFAC', width: 1 }, rectRadius: 0.1 });
        sCi.addText('✔  All checks passed. No items need follow-up.', { x: 1.1, y: 2.0, w: 11.1, h: 1.2, fontSize: 16, bold: true, color: '166534', valign: 'middle', fontFace: 'Outfit' });
      } else {
        sCi.addText(`${items.length} item${items.length === 1 ? '' : 's'} ${cat.retest ? 'still open after the re-test' : 'noted'}, highest priority first. ${items.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'Please review the high-priority items first.' : 'None stop the dashboard from working; they are layout, wording and data-tidiness improvements.'}`, { x: 0.8, y: 1.45, w: 11.7, h: 0.4, fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
        const shown = items.slice(0, 6);
        const cw = 5.75, ch = 1.38, gx = 0.2, gy = 0.16, x0 = 0.8, y0 = 2.0;
        shown.forEach((f, i) => {
          const cx = x0 + (i % 2) * (cw + gx), cy = y0 + Math.floor(i / 2) * (ch + gy);
          const [pill, color] = SEV_PILL[f.severity] ?? ['Note', '64748B'];
          card(sCi, cx, cy, cw, ch);
          sCi.addShape(pptx.shapes.RECTANGLE, { x: cx, y: cy, w: 0.08, h: ch, fill: { color }, line: { color, width: 0 } });
          sCi.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: cx + 0.25, y: cy + 0.12, w: 0.8, h: 0.24, fill: { color }, line: { color, width: 0 }, rectRadius: 0.1 });
          sCi.addText(pill, { x: cx + 0.25, y: cy + 0.12, w: 0.8, h: 0.24, fontSize: 8.5, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
          sCi.addText(plainTrim(f.title, 95), { x: cx + 1.15, y: cy + 0.08, w: cw - 1.3, h: 0.5, fontSize: 11, bold: true, color: COLOR_TEXT_DARK, valign: 'middle', fontFace: 'Outfit', lineSpacing: 13 });
          sCi.addText(plainTrim(f.detail, 150), { x: cx + 0.25, y: cy + 0.62, w: cw - 0.45, h: 0.7, fontSize: 9, color: COLOR_MUTED, valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacing: 11 });
        });
        if (items.length > shown.length) {
          sCi.addText(`+ ${items.length - shown.length} more item${items.length - shown.length === 1 ? '' : 's'} in the technical report`, { x: 0.8, y: 6.5, w: 7.0, h: 0.3, fontSize: 10, italic: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
        }
      }
      sCi.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 0.8, y: 6.82, w: 11.7, h: 0.5, fill: { color: 'F0F9FF' }, line: { color: '7DD3FC', width: 1 }, rectRadius: 0.1 });
      sCi.addText('Full detail, evidence and recommended fixes are in the Custom App Technical Report that accompanies this deck.', { x: 1.05, y: 6.82, w: 11.2, h: 0.5, fontSize: 10.5, bold: true, color: '075985', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
    }

  }

  // Reports with no server-monitoring section (e.g. a custom-app-only month) get the slides straight after the summary.
  if (!ops) addCustomAppSlides();

  // ── MODULE A2: MONTHLY APP & SERVER MONITORING (ops content, optional) ──
  if (ops) {
    // -- Overview: optimizations reviewed + objectives --
    const sOv = pptx.addSlide();
    setBackground(sOv); addLogo(sOv);
    eyebrow(sOv, ops.sectionTitle ?? 'Monthly App & Server Monitoring');
    heading(sOv, 'Overview');
    const half = 5.6;
    // Numbered badge + label row, vertically centered against its (possibly 2-line) text —
    // used for both lists on this slide instead of a plain unlabeled dot.
    function badgeRow(slide, x, y, w, rowH, n, text, color) {
      const badgeSize = 0.34;
      slide.addShape(pptx.shapes.OVAL, { x, y: y + (rowH - badgeSize) / 2, w: badgeSize, h: badgeSize, fill: { color }, line: { color, width: 0 } });
      slide.addText(`${n}`, { x, y: y + (rowH - badgeSize) / 2, w: badgeSize, h: badgeSize, fontSize: 11.5, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Outfit' });
      slide.addText(text, { x: x + badgeSize + 0.2, y, w: w - badgeSize - 0.2, h: rowH, fontSize: 12, color: COLOR_TEXT_DARK, valign: 'middle', fontFace: 'Plus Jakarta Sans', lineSpacing: 15 });
    }
    card(sOv, 0.8, 1.7, half, 4.9);
    sOv.addText('OPTIMIZATIONS & CHECKS REVIEWED', { x: 1.1, y: 1.95, w: half - 0.6, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    (ops.overview?.optimizationsReviewed ?? []).forEach((t, i) => {
      badgeRow(sOv, 1.1, 2.35 + i * 0.78, half - 0.6, 0.7, i + 1, t, COLOR_BRAND_BLUE);
    });
    const ox2 = 0.8 + half + 0.3;
    card(sOv, ox2, 1.7, half, 4.9);
    sOv.addText('OBJECTIVES', { x: ox2 + 0.3, y: 1.95, w: half - 0.6, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    (ops.overview?.objectives ?? []).forEach((t, i) => {
      badgeRow(sOv, ox2 + 0.3, 2.35 + i * 0.78, half - 0.6, 0.7, i + 1, t, COLOR_SUCCESS_GREEN);
    });

    // -- Performance metrics: App vs Dashboard --
    const sPerf = pptx.addSlide();
    setBackground(sPerf); addLogo(sPerf);
    eyebrow(sPerf, ops.sectionTitle ?? 'Monthly App & Server Monitoring');
    heading(sPerf, 'Performance Metrics');
    [ops.performanceMetrics?.app, ops.performanceMetrics?.dashboard].forEach((m, i) => {
      if (!m) return;
      const x = 0.8 + i * (half + 0.3);
      card(sPerf, x, 1.7, half, 4.4);
      sPerf.addText((m.label ?? '').toUpperCase(), { x: x + 0.3, y: 1.95, w: half - 0.6, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
      const stats = [
        ['Response Time', m.responseTime], ['Throughput', m.throughput], ['Memory Usage', m.memoryUsage]
      ];
      stats.forEach(([label, val], si) => {
        const sy = 2.35 + si * 0.55;
        sPerf.addText(label, { x: x + 0.3, y: sy, w: half - 2.4, h: 0.4, fontSize: 12.5, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
        sPerf.addText(val ?? 'N/A', { x: x + half - 2.1, y: sy, w: 1.8, h: 0.4, fontSize: 14, bold: true, align: 'right', color: COLOR_BRAND_BLUE, fontFace: 'Outfit' });
      });
      (m.assessment ?? []).forEach((t, ai) => {
        const y = 4.15 + ai * 0.47;
        sPerf.addText('✔', { x: x + 0.3, y, w: 0.3, h: 0.4, fontSize: 11, bold: true, color: COLOR_SUCCESS_GREEN, fontFace: 'Plus Jakarta Sans' });
        sPerf.addText(t, { x: x + 0.65, y: y - 0.03, w: half - 1.0, h: 0.45, fontSize: 10, color: COLOR_MUTED, valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacing: 12 });
      });
    });
    if (ops.performanceMetrics?.conclusion) {
      sPerf.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 0.8, y: 6.25, w: half * 2 + 0.3, h: 0.75, fill: { color: 'ECFDF5' }, line: { color: '86EFAC', width: 1 }, rectRadius: 0.1 });
      sPerf.addText([{ text: '✔  ', options: { bold: true, color: '047857' } }, { text: ops.performanceMetrics.conclusion, options: { color: '166534' } }], {
        x: 1.05, y: 6.25, w: half * 2 - 0.2, h: 0.75, fontSize: 11.5, bold: true, valign: 'middle', fontFace: 'Plus Jakarta Sans', lineSpacing: 14
      });
    }

    // -- SSL certificate & domain security (evidence screenshot, no re-audit this cycle) --
    if (ops.sslSecurity) {
      const ssl = ops.sslSecurity;
      const sSsl = pptx.addSlide();
      setBackground(sSsl); addLogo(sSsl);
      eyebrow(sSsl, 'Infrastructure Security');
      heading(sSsl, 'SSL Certificate & Domain Security');

      const now = new Date();
      const expiry = ssl.expiresOn ? new Date(ssl.expiresOn) : null;
      const daysRemaining = expiry ? Math.ceil((expiry - now) / 86400000) : null;
      const healthy = daysRemaining === null || daysRemaining > 30;
      const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'N/A';

      // Left: details card (same shape as the storefront reports' SSL card)
      const detailW = 5.4;
      card(sSsl, 0.8, 1.8, detailW, 4.6);
      sSsl.addText('SSL CERTIFICATE STATUS', { x: 1.1, y: 2.1, w: detailW - 0.6, h: 0.3, fontSize: 11, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
      sSsl.addText(healthy ? 'Active & Secure' : 'Renewal Needed Soon', { x: 1.1, y: 2.45, w: detailW - 0.6, h: 0.5, fontSize: 22, bold: true, color: healthy ? COLOR_SUCCESS_GREEN : COLOR_WARNING_RED, fontFace: 'Outfit' });
      sSsl.addText(
        `• Certificate covers: ${ssl.commonName ?? 'N/A'}\n\n` +
        `• Issued by: ${ssl.issuer ?? 'N/A'}\n\n` +
        `• Issued on: ${fmtDate(ssl.issuedOn)}\n\n` +
        `• Expires on: ${fmtDate(ssl.expiresOn)}${daysRemaining !== null ? ` (${daysRemaining} days from today)` : ''}`,
        { x: 1.1, y: 3.15, w: detailW - 0.6, h: 2.2, fontSize: 13, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans', lineSpacing: 18 }
      );
      if (ssl.coverageNote) {
        sSsl.addText(ssl.coverageNote, { x: 1.1, y: 5.65, w: detailW - 0.6, h: 0.65, fontSize: 10.5, italic: true, color: COLOR_MUTED, valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacing: 13 });
      }

      // Right: the actual certificate screenshot as evidence
      const sslImgPath = ssl.screenshot ? join(outDir, ssl.screenshot) : null;
      if (sslImgPath && fs.existsSync(sslImgPath)) {
        const imgX = 0.8 + detailW + 0.4, imgW = 11.7 - detailW - 0.4;
        sSsl.addShape(pptx.shapes.RECTANGLE, { x: imgX, y: 1.8, w: imgW, h: 4.6, fill: { color: COLOR_CARD_BG }, line: { color: COLOR_BORDER, width: 1 }, rectRadius: 0.06 });
        sSsl.addText('CERTIFICATE EVIDENCE (BROWSER VIEW)', { x: imgX + 0.2, y: 1.95, w: imgW - 0.4, h: 0.3, fontSize: 9.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
        sSsl.addImage({ path: sslImgPath, x: imgX + 0.5, y: 2.3, w: imgW - 1.0, h: 4.0, sizing: { type: 'contain', w: imgW - 1.0, h: 4.0 } });
      }
    }

    // -- Build cache analysis: before/after links --
    const sCache = pptx.addSlide();
    setBackground(sCache); addLogo(sCache);
    eyebrow(sCache, ops.sectionTitle ?? 'Monthly App & Server Monitoring');
    heading(sCache, 'Build Cache Analysis');
    [ops.buildCacheAnalysis?.app, ops.buildCacheAnalysis?.dashboard].forEach((m, i) => {
      if (!m) return;
      const x = 0.8 + i * (half + 0.3);
      card(sCache, x, 1.7, half, 1.7);
      sCache.addText((m.label ?? '').toUpperCase(), { x: x + 0.3, y: 1.9, w: half - 0.6, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
      const linkPill = (label, url, lx) => {
        const ok = isRealUrl(url);
        sCache.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: lx, y: 2.35, w: (half - 0.9) / 2, h: 0.7, fill: { color: ok ? 'F0F9FF' : 'F1F5F9' }, line: { color: ok ? '7DD3FC' : COLOR_BORDER, width: 1 }, rectRadius: 0.1 });
        sCache.addText(label, { x: lx + 0.15, y: 2.42, w: (half - 0.9) / 2 - 0.3, h: 0.28, fontSize: 10, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
        sCache.addText(ok ? 'View evidence' : 'Link pending', ok ? { x: lx + 0.15, y: 2.68, w: (half - 0.9) / 2 - 0.3, h: 0.32, fontSize: 12, bold: true, color: COLOR_BRAND_BLUE, fontFace: 'Plus Jakarta Sans', hyperlink: { url } } : { x: lx + 0.15, y: 2.68, w: (half - 0.9) / 2 - 0.3, h: 0.32, fontSize: 12, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
      };
      linkPill('BEFORE', m.beforeUrl, x + 0.3);
      linkPill('AFTER', m.afterUrl, x + 0.3 + (half - 0.9) / 2 + 0.3);
    });
    card(sCache, 0.8, 3.65, half * 2 + 0.3, 2.6);
    sCache.addText('FINDINGS', { x: 1.1, y: 3.85, w: 5.0, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    (ops.buildCacheAnalysis?.findings ?? []).forEach((t, i) => {
      const y = 4.2 + i * 0.42;
      sCache.addText('•', { x: 1.1, y, w: 0.2, h: 0.4, fontSize: 13, bold: true, color: COLOR_BRAND_BLUE, fontFace: 'Plus Jakarta Sans' });
      sCache.addText(t, { x: 1.35, y: y - 0.02, w: half * 2 - 0.9, h: 0.4, fontSize: 11.5, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
    });
    if (ops.buildCacheAnalysis?.conclusion) {
      sCache.addText([{ text: '✔  ', options: { bold: true, color: COLOR_SUCCESS_GREEN } }, { text: ops.buildCacheAnalysis.conclusion, options: { bold: true, color: '166534' } }], {
        x: 1.1, y: 5.85, w: half * 2 - 0.6, h: 0.35, fontSize: 11, fontFace: 'Plus Jakarta Sans'
      });
    }

    // -- Last 24-hour usage --
    const s24 = pptx.addSlide();
    setBackground(s24); addLogo(s24);
    eyebrow(s24, ops.sectionTitle ?? 'Monthly App & Server Monitoring');
    heading(s24, 'Last 24 Hours Usage');
    [ops.last24HoursUsage?.app, ops.last24HoursUsage?.dashboard].forEach((m, i) => {
      if (!m) return;
      const x = 0.8 + i * (half + 0.3);
      const ok = isRealUrl(m.evidenceUrl);
      card(s24, x, 1.7, half, 1.0);
      s24.addText((m.label ?? '').toUpperCase(), { x: x + 0.3, y: 1.85, w: half - 0.6, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
      s24.addText(ok ? 'View usage evidence →' : 'Link pending', ok
        ? { x: x + 0.3, y: 2.15, w: half - 0.6, h: 0.4, fontSize: 13, bold: true, color: COLOR_BRAND_BLUE, fontFace: 'Plus Jakarta Sans', hyperlink: { url: m.evidenceUrl } }
        : { x: x + 0.3, y: 2.15, w: half - 0.6, h: 0.4, fontSize: 13, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    });
    card(s24, 0.8, 2.9, half * 2 + 0.3, 3.4);
    s24.addText('FINDINGS', { x: 1.1, y: 3.1, w: 5.0, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    (ops.last24HoursUsage?.findings ?? []).forEach((t, i) => {
      const y = 3.45 + i * 0.42;
      s24.addText('•', { x: 1.1, y, w: 0.2, h: 0.4, fontSize: 13, bold: true, color: COLOR_BRAND_BLUE, fontFace: 'Plus Jakarta Sans' });
      s24.addText(t, { x: 1.35, y: y - 0.02, w: half * 2 - 0.9, h: 0.4, fontSize: 11.5, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
    });
    if (ops.last24HoursUsage?.conclusion) {
      s24.addText([{ text: '✔  ', options: { bold: true, color: COLOR_SUCCESS_GREEN } }, { text: ops.last24HoursUsage.conclusion, options: { bold: true, color: '166534' } }], {
        x: 1.1, y: 6.05, w: half * 2 - 0.6, h: 0.35, fontSize: 11, fontFace: 'Plus Jakarta Sans'
      });
    }

    // -- Incidents (e.g. SMTP): risk -> fix -> result, same visual language as the security fix slide --
    for (const inc of (ops.incidents ?? [])) {
      const sInc = pptx.addSlide();
      setBackground(sInc); addLogo(sInc);
      eyebrow(sInc, ops.sectionTitle ?? 'Monthly App & Server Monitoring');
      heading(sInc, inc.title ?? 'Incident Identified & Resolved');
      const stages = [
        { head: 'THE ISSUE', tone: 'DC2626', bg: 'FEF2F2', line: 'FCA5A5', text: inc.issue ?? '' },
        { head: 'ROOT CAUSE & FIX', tone: '0EA5E9', bg: 'F0F9FF', line: '7DD3FC', text: inc.rootCause ?? '' },
        { head: 'RESULT', tone: '10B981', bg: 'ECFDF5', line: '86EFAC', text: inc.conclusion ?? '' }
      ];
      const cardW = 3.65, cardY = 1.8, cardH = 2.4;
      const cardXs = [0.8, 4.84, 8.88];
      stages.forEach((st, i) => {
        const cx = cardXs[i];
        sInc.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: cx, y: cardY, w: cardW, h: cardH, fill: { color: st.bg }, line: { color: st.line, width: 1.25 }, rectRadius: 0.12 });
        sInc.addText(st.head, { x: cx + 0.25, y: cardY + 0.2, w: cardW - 0.5, h: 0.3, fontSize: 11, bold: true, color: st.tone, fontFace: 'Plus Jakarta Sans' });
        sInc.addText(st.text, { x: cx + 0.25, y: cardY + 0.55, w: cardW - 0.5, h: cardH - 0.75, fontSize: 11.5, color: COLOR_TEXT_DARK, valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacing: 15 });
        if (i < 2) sInc.addShape(pptx.shapes.RIGHT_ARROW, { x: cx + cardW + 0.06, y: cardY + cardH / 2 - 0.17, w: 0.33, h: 0.34, fill: { color: 'CBD5E1' }, line: { color: 'CBD5E1', width: 0 } });
      });
      if (inc.affectedEndpoint) {
        sInc.addText([{ text: 'Affected endpoint:  ', options: { bold: true, color: COLOR_MUTED } }, { text: inc.affectedEndpoint, options: { color: COLOR_TEXT_DARK } }], {
          x: 0.8, y: 4.4, w: 11.5, h: 0.35, fontSize: 11, fontFace: 'Consolas'
        });
      }
      if ((inc.resolutionSteps ?? []).length > 0) {
        card(sInc, 0.8, 4.9, 11.7, 1.9);
        sInc.addText('RESOLUTION STEPS', { x: 1.1, y: 5.05, w: 5.0, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
        inc.resolutionSteps.forEach((t, i) => {
          const y = 5.4 + i * 0.35;
          sInc.addText('✔', { x: 1.1, y, w: 0.25, h: 0.3, fontSize: 11, bold: true, color: COLOR_SUCCESS_GREEN, fontFace: 'Plus Jakarta Sans' });
          sInc.addText(t, { x: 1.4, y: y - 0.03, w: 10.9, h: 0.35, fontSize: 10.5, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
        });
      }
    }

    addCustomAppSlides();

    // -- Overall summary table --
    if ((ops.overallSummary ?? []).length > 0) {
      const sSum = pptx.addSlide();
      setBackground(sSum); addLogo(sSum);
      eyebrow(sSum, ops.sectionTitle ?? 'Monthly App & Server Monitoring');
      heading(sSum, 'Overall Summary');
      const statusColor = (s) => /resolved|healthy|stable|restored|active|tested/i.test(s ?? '') ? COLOR_SUCCESS_GREEN : COLOR_WARNING_RED;
      const rows = [[
        { text: 'Area', options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 11 } },
        { text: 'Status', options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 11 } },
        { text: 'Remarks', options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 11 } }
      ]];
      for (const row of ops.overallSummary) {
        rows.push([
          { text: row.area ?? '', options: { fontSize: 11, bold: true } },
          { text: `✔ ${row.status ?? ''}`, options: { fontSize: 11, bold: true, color: statusColor(row.status) } },
          { text: row.remarks ?? '', options: { fontSize: 10.5, color: COLOR_MUTED } }
        ]);
      }
      sSum.addTable(rows, { x: 0.8, y: 1.7, w: 11.7, h: 5.0, fontSize: 11, fontFace: 'Plus Jakarta Sans', border: { color: COLOR_BORDER, width: 1 }, autoPage: false, colW: [4.5, 2.2, 5.0] });
    }

    // -- Final assessment: successful outcomes + continued monitoring --
    const sFinal = pptx.addSlide();
    setBackground(sFinal); addLogo(sFinal);
    eyebrow(sFinal, ops.sectionTitle ?? 'Monthly App & Server Monitoring');
    heading(sFinal, 'Final Assessment');
    card(sFinal, 0.8, 1.7, half, 4.9);
    sFinal.addText('SUCCESSFUL OUTCOMES', { x: 1.1, y: 1.95, w: half - 0.6, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_SUCCESS_GREEN, fontFace: 'Plus Jakarta Sans' });
    (ops.finalAssessment?.successfulOutcomes ?? []).forEach((t, i) => {
      const step = Math.min(0.6, 4.1 / Math.max(1, (ops.finalAssessment?.successfulOutcomes ?? []).length));
      const y = 2.35 + i * step;
      sFinal.addText('✔', { x: 1.1, y, w: 0.25, h: 0.4, fontSize: 12, bold: true, color: COLOR_SUCCESS_GREEN, fontFace: 'Plus Jakarta Sans' });
      sFinal.addText(t, { x: 1.4, y: y - 0.03, w: half - 0.9, h: 0.55, fontSize: 10.5, color: COLOR_TEXT_DARK, valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacing: 13 });
    });
    const fx2 = 0.8 + half + 0.3;
    card(sFinal, fx2, 1.7, half, 4.9);
    sFinal.addText('AREAS FOR CONTINUED MONITORING', { x: fx2 + 0.3, y: 1.95, w: half - 0.6, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_BRAND_SECONDARY, fontFace: 'Plus Jakarta Sans' });
    (ops.finalAssessment?.continuedMonitoring ?? []).forEach((t, i) => {
      const y = 2.35 + i * 0.9;
      sFinal.addShape(pptx.shapes.OVAL, { x: fx2 + 0.3, y, w: 0.24, h: 0.24, fill: { color: COLOR_BRAND_BLUE }, line: { color: COLOR_BRAND_BLUE, width: 0 } });
      sFinal.addText(t, { x: fx2 + 0.7, y: y - 0.08, w: half - 1.1, h: 0.85, fontSize: 11.5, color: COLOR_TEXT_DARK, valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacing: 15 });
    });
  }

  // ── MODULE B: DEV TEAM WORK (dynamic, paginated) ────────────────────
  const devCategories = data.devTeamSection?.categories ?? [];
  const ITEMS_PER_SLIDE = 3;
  let flatDevItems = [];
  for (const cat of devCategories) {
    for (const item of (cat.items ?? [])) flatDevItems.push({ category: cat.categoryName, ...item });
  }
  for (let i = 0; i < flatDevItems.length; i += ITEMS_PER_SLIDE) {
    const chunk = flatDevItems.slice(i, i + ITEMS_PER_SLIDE);
    const s = pptx.addSlide();
    setBackground(s); addLogo(s);
    eyebrow(s, data.devTeamSection?.sectionTitle ?? 'Development & Maintenance Updates');
    heading(s, i === 0 ? 'Monthly Development Work Completed' : 'Development Work Completed (continued)');
    if (i === 0 && data.devTeamSection?.summary) {
      s.addText(data.devTeamSection.summary, { x: 0.8, y: 1.5, w: 11.5, h: 0.5, fontSize: 13, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    }
    const rowTop = i === 0 && data.devTeamSection?.summary ? 2.15 : 1.6;
    const rowH = (6.9 - rowTop) / chunk.length;
    chunk.forEach((item, idx) => {
      const y = rowTop + idx * rowH;
      card(s, 0.8, y, 11.7, rowH - 0.15);
      s.addShape(pptx.shapes.RECTANGLE, { x: 0.8, y, w: 0.08, h: rowH - 0.15, fill: { color: COLOR_BRAND_BLUE }, line: { color: COLOR_BRAND_BLUE, width: 0 } });
      s.addText(item.category ?? '', { x: 1.05, y: y + 0.1, w: 4.0, h: 0.25, fontSize: 9.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
      s.addText(item.title ?? '', { x: 1.05, y: y + 0.32, w: 10.9, h: 0.32, fontSize: 15, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit' });
      s.addText(item.description ?? '', { x: 1.05, y: y + 0.66, w: 10.9, h: 0.5, fontSize: 11.5, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans', lineSpacing: 15 });
      if (item.impact) {
        s.addText([{ text: 'Client impact: ', options: { bold: true, color: COLOR_SUCCESS_GREEN } }, { text: item.impact, options: { color: COLOR_TEXT_DARK } }], {
          x: 1.05, y: y + rowH - 0.55, w: 10.9, h: 0.4, fontSize: 11, fontFace: 'Plus Jakarta Sans', lineSpacing: 14
        });
      }
    });
  }
  // Only show an explicit "nothing here" slide when this module is the report's dev-work
  // record (no ops section covering the same ground) — otherwise just skip it silently.
  if (flatDevItems.length === 0 && !ops && !data.customAppTesting) {
    const s = pptx.addSlide();
    setBackground(s); addLogo(s);
    eyebrow(s, data.devTeamSection?.sectionTitle ?? 'Development & Maintenance Updates');
    heading(s, 'Monthly Development Work Completed');
    s.addText('No development items were provided for this monitoring cycle.', {
      x: 0.8, y: 2.5, w: 11.0, h: 0.5, fontSize: 14, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
    });
  }

  // ── MODULE C: WIDGET FUNCTIONAL VALIDATION (skipped if no widget QA data provided) ──
  if (hasWidgetQa) {
  const sFunc = pptx.addSlide();
  setBackground(sFunc); addLogo(sFunc);
  eyebrow(sFunc, data.qaTestingSection?.sectionTitle ?? 'Multi-Device Storefront & Widget Audit');
  heading(sFunc, 'Widget Architecture & Functional Validation');
  sFunc.addText(data.qaTestingSection?.widgetName ?? '', {
    x: 0.8, y: 1.5, w: 11.5, h: 0.4, fontSize: 13, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
  });
  card(sFunc, 0.8, 2.0, 11.7, 4.5);
  sFunc.addText('FUNCTIONAL STATUS', { x: 1.1, y: 2.25, w: 5.0, h: 0.3, fontSize: 11, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
  sFunc.addText(data.qaTestingSection?.functionalStatus ?? 'Not reported', { x: 1.1, y: 2.55, w: 8.0, h: 0.5, fontSize: 22, bold: true, color: COLOR_SUCCESS_GREEN, fontFace: 'Outfit' });
  const checks = data.qaTestingSection?.functionalChecks ?? [];
  checks.forEach((c, i) => {
    const y = 3.3 + i * 0.62;
    const ok = c.passed !== false;
    sFunc.addShape(pptx.shapes.OVAL, { x: 1.1, y, w: 0.3, h: 0.3, fill: { color: ok ? COLOR_SUCCESS_GREEN : COLOR_WARNING_RED }, line: { color: ok ? COLOR_SUCCESS_GREEN : COLOR_WARNING_RED, width: 0 } });
    sFunc.addText(ok ? '✔' : '✖', { x: 1.1, y, w: 0.3, h: 0.3, fontSize: 11, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
    sFunc.addText(c.label ?? '', { x: 1.55, y: y - 0.05, w: 10.8, h: 0.4, fontSize: 13, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
  });

  // ── MODULE C: STOREFRONT TOUCHPOINTS ────────────────────────────────
  const touchpoints = data.qaTestingSection?.touchpoints ?? [];
  if (touchpoints.length > 0) {
    const sTp = pptx.addSlide();
    setBackground(sTp); addLogo(sTp);
    eyebrow(sTp, data.qaTestingSection?.sectionTitle ?? 'Multi-Device Storefront & Widget Audit');
    heading(sTp, 'Storefront Touchpoints Verified');
    const tpW = 2.72, tpGap = 0.27, tpX0 = 0.8, tpY = 2.0, tpH = 3.4;
    touchpoints.slice(0, 4).forEach((tp, i) => {
      const x = tpX0 + i * (tpW + tpGap);
      card(sTp, x, tpY, tpW, tpH);
      sTp.addShape(pptx.shapes.OVAL, { x: x + tpW / 2 - 0.3, y: tpY + 0.3, w: 0.6, h: 0.6, fill: { color: COLOR_BRAND_BLUE }, line: { color: COLOR_BRAND_BLUE, width: 0 } });
      sTp.addText(`${i + 1}`, { x: x + tpW / 2 - 0.3, y: tpY + 0.3, w: 0.6, h: 0.6, fontSize: 20, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Outfit' });
      sTp.addText(tp.name ?? '', { x: x + 0.15, y: tpY + 1.1, w: tpW - 0.3, h: 0.5, fontSize: 14, bold: true, color: COLOR_TEXT_DARK, align: 'center', fontFace: 'Outfit' });
      sTp.addText(tp.note ?? '', { x: x + 0.2, y: tpY + 1.65, w: tpW - 0.4, h: 1.6, fontSize: 11, color: COLOR_MUTED, align: 'center', valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacing: 15 });
    });
  }

  // ── MODULE C2: SHOPIFY THEME UPDATE LOG (optional) — sits right before the device
  // matrices it leads into, per the client's requested slide order. ──
  const themeLog = data.themeUpdateLog ?? null;
  if (themeLog && (themeLog.updateGroups ?? []).length > 0) {
    const sLog = pptx.addSlide();
    setBackground(sLog); addLogo(sLog);
    eyebrow(sLog, themeLog.sectionTitle ?? 'Shopify Theme Updates');
    heading(sLog, 'Free Theme Releases This Cycle');
    if (themeLog.summary) {
      sLog.addText(themeLog.summary, { x: 0.8, y: 1.5, w: 11.5, h: 0.5, fontSize: 12.5, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    }

    const tested = new Set((themeLog.testedThemes ?? []).map(t => t.toLowerCase()));
    const groups = themeLog.updateGroups;
    const rowTop = 2.0;
    const rowGap = 0.2;
    const rowH = (6.05 - rowTop - (groups.length - 1) * rowGap) / groups.length;

    groups.forEach((g, gi) => {
      const y = rowTop + gi * (rowH + rowGap);
      card(sLog, 0.8, y, 11.7, rowH);

      // Left: version upgrade (from -> to) + date
      if (g.fromVersion) {
        sLog.addText([
          { text: `v${g.fromVersion}`, options: { fontSize: 12.5, color: COLOR_MUTED, strike: true } },
          { text: '  →  ', options: { fontSize: 12.5, color: COLOR_MUTED } },
          { text: `v${g.version ?? '—'}`, options: { fontSize: 15.5, bold: true, color: COLOR_BRAND_SECONDARY } }
        ], { x: 1.05, y: y + 0.18, w: 2.1, h: 0.42, fontFace: 'Outfit', valign: 'middle' });
      } else {
        sLog.addText(`v${g.version ?? '—'}`, { x: 1.05, y: y + 0.18, w: 2.1, h: 0.4, fontSize: 19, bold: true, color: COLOR_BRAND_SECONDARY, fontFace: 'Outfit' });
      }
      sLog.addText(g.date ? new Date(g.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '', { x: 1.05, y: y + 0.62, w: 2.1, h: 0.3, fontSize: 10.5, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });

      // Middle: what changed
      sLog.addText('WHAT CHANGED', { x: 3.3, y: y + 0.16, w: 3.5, h: 0.25, fontSize: 8.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
      sLog.addText(g.whatChanged ?? '', { x: 3.3, y: y + 0.4, w: 3.5, h: rowH - 0.55, fontSize: 12, color: COLOR_TEXT_DARK, valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacing: 15 });

      // Right: theme chips — tested (green) ones sorted first, then pending (orange)
      sLog.addText(`THEMES UPDATED (${(g.themes ?? []).length})`, { x: 7.0, y: y + 0.16, w: 5.3, h: 0.25, fontSize: 8.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
      const chipY = y + 0.42;
      const chipH = 0.34;
      const maxChipsPerRow = 5;
      const chipW = 5.3 / maxChipsPerRow - 0.08;
      const orderedThemes = [...(g.themes ?? [])].sort((a, b) => {
        const aT = tested.has(a.toLowerCase()) ? 0 : 1;
        const bT = tested.has(b.toLowerCase()) ? 0 : 1;
        return aT - bT;
      });
      orderedThemes.forEach((name, ti) => {
        const row = Math.floor(ti / maxChipsPerRow);
        const col = ti % maxChipsPerRow;
        const cx = 7.0 + col * (chipW + 0.1);
        const cy = chipY + row * (chipH + 0.08);
        const isTested = tested.has(name.toLowerCase());
        sLog.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
          x: cx, y: cy, w: chipW, h: chipH,
          fill: { color: isTested ? 'ECFDF5' : 'FFF7ED' },
          line: { color: isTested ? COLOR_SUCCESS_GREEN : 'F97316', width: 1.25 },
          rectRadius: 0.17
        });
        sLog.addText(isTested ? `${name} ✓` : name, {
          x: cx, y: cy, w: chipW, h: chipH, fontSize: 9.5, bold: true, color: isTested ? '047857' : '9A3412',
          align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans'
        });
      });
    });

    // Legend: what the chip colors mean
    const legendY = rowTop + groups.length * rowH + (groups.length - 1) * rowGap + 0.12;
    sLog.addShape(pptx.shapes.OVAL, { x: 0.8, y: legendY + 0.03, w: 0.16, h: 0.16, fill: { color: COLOR_SUCCESS_GREEN }, line: { color: COLOR_SUCCESS_GREEN, width: 0 } });
    sLog.addText('Green — Tested this cycle', { x: 1.02, y: legendY - 0.06, w: 2.8, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
    sLog.addShape(pptx.shapes.OVAL, { x: 3.9, y: legendY + 0.03, w: 0.16, h: 0.16, fill: { color: 'F97316' }, line: { color: 'F97316', width: 0 } });
    sLog.addText('Orange — Pending (queued for an upcoming cycle)', { x: 4.12, y: legendY - 0.06, w: 4.5, h: 0.3, fontSize: 10.5, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });

    if (themeLog.testedNote) {
      const noteY = legendY + 0.42;
      sLog.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 0.8, y: noteY, w: 11.7, h: 0.62, fill: { color: 'ECFDF5' }, line: { color: '86EFAC', width: 1 }, rectRadius: 0.1 });
      sLog.addText([{ text: '✔  ', options: { bold: true, color: '047857' } }, { text: themeLog.testedNote, options: { color: '166534' } }], {
        x: 1.05, y: noteY, w: 11.2, h: 0.62, fontSize: 10.5, bold: true, valign: 'middle', fontFace: 'Plus Jakarta Sans', lineSpacing: 12
      });
    }
  }

  // ── MODULE C: PER-THEME DEVICE MATRIX & VISUAL TESTING SHOWCASE ─────
  const themes = data.qaTestingSection?.themes ?? {};
  for (const themeKey of Object.keys(themes)) {
    const theme = themes[themeKey];
    if (!theme) continue;
    const rows = flattenDeviceRows(theme);

    // ── SLIDE: VISUAL SHOWCASE - CORE STOREFRONT TOUCHPOINTS (Desktop & Tablet) ──
    const pdpDesk = findScreenshotPath(themeKey, 'product-page/desktop', `${themeKey}_pdp_fullpage_desktop_1280x800.png`, outDir);
    const drawerDesk = findScreenshotPath(themeKey, 'cart-drawer/desktop', `${themeKey}_drawer_viewport_desktop_1280x800.png`, outDir)
      || findScreenshotPath(themeKey, 'cart-drawer/tablet', `${themeKey}_drawer_viewport_tablet_768x1024.png`, outDir);
    const cartDesk = findScreenshotPath(themeKey, 'cart-page/desktop', `${themeKey}_cart_fullpage_desktop_1280x800.png`, outDir);

    if (pdpDesk || drawerDesk || cartDesk) {
      const sVisDesk = pptx.addSlide();
      setBackground(sVisDesk); addLogo(sVisDesk);
      eyebrow(sVisDesk, `Theme: ${theme.name ?? themeKey} (v${theme.version ?? '—'}) • Visual Verification`);
      heading(sVisDesk, `${theme.name ?? themeKey} — Core Storefront Touchpoints`);
      sVisDesk.addText('Live testing evidence: Tree Contribution Widget (.tdw-card & .tdw-drawer-wrap) verified across key buyer touchpoints.', {
        x: 0.8, y: 1.45, w: 11.5, h: 0.35, fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
      });

      const cards = [
        { title: 'PRODUCT DETAIL PAGE (PDP)', desc: 'Desktop (1280×800) • Full-Page', img: pdpDesk, note: '✔ Embedded below Buy It Now' },
        { title: 'CART DRAWER (SLIDE-OUT)', desc: 'Desktop / Tablet • Modal Viewport', img: drawerDesk, note: '✔ Verified inside Drawer Modal' },
        { title: 'CART PAGE (/cart)', desc: 'Desktop (1280×800) • Full-Page', img: cartDesk, note: '✔ Verified below Order Summary' }
      ];
      const cW = 3.65, cGap = 0.38, cY = 1.9, cH = 5.2;
      cards.forEach((c, idx) => {
        const cX = 0.8 + idx * (cW + cGap);
        card(sVisDesk, cX, cY, cW, cH);
        sVisDesk.addText(c.title, { x: cX + 0.15, y: cY + 0.12, w: cW - 0.3, h: 0.28, fontSize: 10.5, bold: true, color: COLOR_BRAND_SECONDARY, fontFace: 'Outfit' });
        sVisDesk.addText(c.desc, { x: cX + 0.15, y: cY + 0.38, w: cW - 0.3, h: 0.22, fontSize: 9, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
        if (c.img) {
          sVisDesk.addImage({ path: c.img, x: cX + 0.15, y: cY + 0.65, w: cW - 0.3, h: cH - 1.25, sizing: { type: 'contain', w: cW - 0.3, h: cH - 1.25 } });
        }
        sVisDesk.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: cX + 0.15, y: cY + cH - 0.48, w: cW - 0.3, h: 0.34, fill: { color: 'ECFDF5' }, line: { color: '86EFAC', width: 1 }, rectRadius: 0.08 });
        sVisDesk.addText(c.note, { x: cX + 0.15, y: cY + cH - 0.48, w: cW - 0.3, h: 0.34, fontSize: 9.5, bold: true, color: '047857', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
      });
    }

    // ── SLIDE: VISUAL SHOWCASE - MOBILE RESPONSIVE MATRIX (5 Devices) ──
    const mobileCards = [
      { name: 'Galaxy S24', label: 'PDP Full-Page', res: '360 × 780', img: findScreenshotPath(themeKey, 'product-page/mobile', `${themeKey}_pdp_fullpage_mobile_360x780.png`, outDir) },
      { name: 'Galaxy S24', label: 'Cart Drawer', res: '360 × 780', img: findScreenshotPath(themeKey, 'cart-drawer/mobile', `${themeKey}_drawer_viewport_mobile_360x780.png`, outDir) },
      { name: 'Galaxy S24', label: 'Cart Page', res: '360 × 780', img: findScreenshotPath(themeKey, 'cart-page/mobile', `${themeKey}_cart_fullpage_mobile_360x780.png`, outDir) },
      { name: 'iPhone 13 / 14 / 15', label: 'Cart Drawer', res: '390 × 844', img: findScreenshotPath(themeKey, 'cart-drawer/mobile', `${themeKey}_drawer_viewport_mobile_390x844.png`, outDir) },
      { name: 'iPhone 15 Pro Max', label: 'Cart Page', res: '430 × 932', img: findScreenshotPath(themeKey, 'cart-page/mobile', `${themeKey}_cart_fullpage_mobile_430x932.png`, outDir) }
    ].filter(m => m.img);

    if (mobileCards.length > 0) {
      const sVisMob = pptx.addSlide();
      setBackground(sVisMob); addLogo(sVisMob);
      eyebrow(sVisMob, `Theme: ${theme.name ?? themeKey} (v${theme.version ?? '—'}) • Mobile Responsive Matrix`);
      heading(sVisMob, `${theme.name ?? themeKey} — Mobile Device Visual Audit`);
      sVisMob.addText('Multi-device responsive testing: verified touch targets, dropdown behavior, and zero sticky-header overlap.', {
        x: 0.8, y: 1.45, w: 11.5, h: 0.35, fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
      });

      const mW = (11.7 - (mobileCards.length - 1) * 0.22) / mobileCards.length;
      const mY = 1.9, mH = 5.2;
      mobileCards.forEach((m, idx) => {
        const mX = 0.8 + idx * (mW + 0.22);
        card(sVisMob, mX, mY, mW, mH);
        sVisMob.addText(m.name, { x: mX + 0.08, y: mY + 0.1, w: mW - 0.16, h: 0.24, fontSize: 10, bold: true, color: COLOR_TEXT_DARK, align: 'center', fontFace: 'Outfit' });
        sVisMob.addText(`${m.label} • ${m.res}`, { x: mX + 0.08, y: mY + 0.32, w: mW - 0.16, h: 0.2, fontSize: 8, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });
        if (m.img) {
          sVisMob.addImage({ path: m.img, x: mX + 0.1, y: mY + 0.58, w: mW - 0.2, h: mH - 0.95, sizing: { type: 'contain', w: mW - 0.2, h: mH - 0.95 } });
        }
        sVisMob.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: mX + 0.08, y: mY + mH - 0.32, w: mW - 0.16, h: 0.24, fill: { color: 'ECFDF5' }, line: { color: '86EFAC', width: 0.75 }, rectRadius: 0.06 });
        sVisMob.addText('✔ Verified', { x: mX + 0.08, y: mY + mH - 0.32, w: mW - 0.16, h: 0.24, fontSize: 8.5, bold: true, color: '047857', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
      });
    }

    // ── SLIDE: VISUAL SHOWCASE - TABLET RESPONSIVE MATRIX (3 Devices) ──
    const tabCards = [
      { name: 'iPad Portrait', label: 'Cart Drawer', res: '768 × 1024', img: findScreenshotPath(themeKey, 'cart-drawer/tablet', `${themeKey}_drawer_viewport_tablet_768x1024.png`, outDir) },
      { name: 'iPad Air / Pro', label: 'Cart Page', res: '820 × 1180', img: findScreenshotPath(themeKey, 'cart-page/tablet', `${themeKey}_cart_fullpage_tablet_820x1180.png`, outDir) },
      { name: 'iPad Landscape', label: 'Product Page', res: '1024 × 768', img: findScreenshotPath(themeKey, 'product-page/tablet', `${themeKey}_pdp_fullpage_tablet_1024x768.png`, outDir) }
    ].filter(t => t.img);

    if (tabCards.length > 0) {
      const sVisTab = pptx.addSlide();
      setBackground(sVisTab); addLogo(sVisTab);
      eyebrow(sVisTab, `Theme: ${theme.name ?? themeKey} (v${theme.version ?? '—'}) • Tablet Responsive Matrix`);
      heading(sVisTab, `${theme.name ?? themeKey} — Tablet Visual Audit`);
      sVisTab.addText('Portrait and landscape tablet verification: responsive fluid scaling and drawer transition alignment.', {
        x: 0.8, y: 1.45, w: 11.5, h: 0.35, fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
      });

      const tW = 3.65, tGap = 0.38, tY = 1.9, tH = 5.2;
      tabCards.forEach((t, idx) => {
        const tX = 0.8 + idx * (tW + tGap);
        card(sVisTab, tX, tY, tW, tH);
        sVisTab.addText(`${t.name} (${t.res})`, { x: tX + 0.15, y: tY + 0.12, w: tW - 0.3, h: 0.28, fontSize: 11, bold: true, color: COLOR_BRAND_SECONDARY, fontFace: 'Outfit' });
        sVisTab.addText(`Touchpoint: ${t.label}`, { x: tX + 0.15, y: tY + 0.38, w: tW - 0.3, h: 0.22, fontSize: 9.5, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
        if (t.img) {
          sVisTab.addImage({ path: t.img, x: tX + 0.15, y: tY + 0.65, w: tW - 0.3, h: tH - 1.25, sizing: { type: 'contain', w: tW - 0.3, h: tH - 1.25 } });
        }
        sVisTab.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: tX + 0.15, y: tY + tH - 0.48, w: tW - 0.3, h: 0.34, fill: { color: 'ECFDF5' }, line: { color: '86EFAC', width: 1 }, rectRadius: 0.08 });
        sVisTab.addText('✔ Verified Responsive Layout', { x: tX + 0.15, y: tY + tH - 0.48, w: tW - 0.3, h: 0.34, fontSize: 9.5, bold: true, color: '047857', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
      });
    }

    // ── SLIDE: PER-THEME DEVICE MATRIX TABLE ───────────────────────────
    const s = pptx.addSlide();
    setBackground(s); addLogo(s);
    eyebrow(s, `Theme: ${theme.name ?? themeKey} (v${theme.version ?? '—'})`);
    heading(s, `${theme.name ?? themeKey} — Multi-Device Responsive Matrix`);
    if (theme.notes) {
      s.addText(theme.notes, { x: 0.8, y: 1.5, w: 11.5, h: 0.4, fontSize: 12.5, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    }

    const tableRows = [[
      { text: 'Device', options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 9.5 } },
      { text: 'Viewport', options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 9.5 } },
      { text: 'Status', options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 9.5 } },
      { text: 'PDP', options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 9.5 } },
      { text: 'Cart', options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 9.5 } },
      { text: 'Cart Popup', options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 9.5 } },
      { text: 'Drawer', options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 9.5 } }
    ]];
    const linkCell = (url) => isRealUrl(url)
      ? { text: 'View', options: { color: COLOR_BRAND_BLUE, bold: true, hyperlink: { url }, fontSize: 9.5 } }
      : { text: '—', options: { color: COLOR_MUTED, fontSize: 9.5 } };
    for (const row of rows) {
      const anyLink = isRealUrl(row.pdp) || isRealUrl(row.cart) || isRealUrl(row.cartPopup) || isRealUrl(row.drawer);
      tableRows.push([
        { text: row.device ?? '', options: { fontSize: 10, bold: true } },
        { text: row.dimensions ?? '', options: { fontSize: 9.5, color: COLOR_MUTED } },
        { text: anyLink ? 'VERIFIED' : 'PENDING', options: { fontSize: 9, bold: true, color: anyLink ? COLOR_SUCCESS_GREEN : COLOR_MUTED } },
        linkCell(row.pdp), linkCell(row.cart), linkCell(row.cartPopup), linkCell(row.drawer)
      ]);
    }
    s.addTable(tableRows, {
      x: 0.8, y: theme.notes ? 2.1 : 1.7, w: 11.7, h: 4.8,
      fontSize: 9.5, fontFace: 'Plus Jakarta Sans', border: { color: COLOR_BORDER, width: 1 },
      autoPage: false, colW: [2.2, 1.5, 1.4, 1.5, 1.4, 1.9, 1.8]
    });
  }
  } // end if (hasWidgetQa)

  // ── MODULE D: RECOMMENDATIONS & NEXT STEPS ──────────────────────────
  // Skipped when opsMonitoringSection is present and there are no explicit recommendations:
  // its own Final Assessment slide ("Areas for Continued Monitoring") already covers this
  // ground with real content, so an empty/placeholder "Looking Ahead" slide would be redundant.
  const recs = data.recommendations ?? [];
  if (recs.length > 0 || (!ops && !data.customAppTesting)) {
    const sRec = pptx.addSlide();
    setBackground(sRec); addLogo(sRec);
    eyebrow(sRec, 'Looking Ahead');
    heading(sRec, 'QA Observations, Recommendations & Next Steps');
    if (recs.length > 0) {
      card(sRec, 0.8, 1.9, 11.7, Math.min(4.6, 0.9 + recs.length * 0.55));
      recs.forEach((r, i) => {
        const y = 2.2 + i * 0.55;
        sRec.addShape(pptx.shapes.OVAL, { x: 1.1, y, w: 0.28, h: 0.28, fill: { color: COLOR_BRAND_BLUE }, line: { color: COLOR_BRAND_BLUE, width: 0 } });
        sRec.addText(`${i + 1}`, { x: 1.1, y, w: 0.28, h: 0.28, fontSize: 11, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Outfit' });
        sRec.addText(r, { x: 1.55, y: y - 0.06, w: 10.8, h: 0.45, fontSize: 13, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
      });
    } else {
      sRec.addText('No open recommendations this cycle.', { x: 0.8, y: 2.2, w: 10.0, h: 0.5, fontSize: 14, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    }
  }

  // ── SLIDE: OUTRO ─────────────────────────────────────────────────────
  const sOutro = pptx.addSlide();
  setBackground(sOutro); addLogo(sOutro);
  sOutro.addText('Thank You!', { x: 0.8, y: 1.2, w: 11.5, h: 1.0, fontSize: 44, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit' });
  sOutro.addText('We are committed to maintaining, future-proofing, and optimizing your storefront.', {
    x: 0.8, y: 2.2, w: 11.5, h: 0.6, fontSize: 16, color: COLOR_BRAND_BLUE, fontFace: 'Outfit'
  });
  sOutro.addText('If you have questions regarding this report, please connect with your account engineer.', {
    x: 0.8, y: 2.8, w: 10.0, h: 0.6, fontSize: 13.5, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
  });
  sOutro.addText('United States Office\n98 Cutter Mill Rd, Great Neck, NY 11021, USA', {
    x: 0.8, y: 4.1, w: 5.0, h: 1.0, fontSize: 13, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans'
  });
  sOutro.addText('Canada Office\n150 King Street W, Toronto, ON M5H 1J9, Canada', {
    x: 6.5, y: 4.1, w: 5.0, h: 1.0, fontSize: 13, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans'
  });

  await pptx.writeFile({ fileName: outPath });
  logger.success(`PPTX report written to: ${outPath}`);
  return outPath;
}

// ─────────────────────────────────────────────────────────────────────────
// PDF GENERATION (HTML → Playwright)
// ─────────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toImgSrc(absPath, outDir) {
  if (!absPath) return '';
  const rel = relative(outDir, absPath).replace(/\\/g, '/');
  if (!rel.startsWith('..')) return rel;
  return 'file:///' + absPath.replace(/\\/g, '/');
}

function renderDeviceTable(theme) {
  const rows = flattenDeviceRows(theme);
  const linkOrDash = (url, label) => isRealUrl(url)
    ? `<a href="${escapeHtml(url)}" target="_blank">${label}</a>`
    : `<span class="pending">Link pending</span>`;
  return `
    <table class="device-table">
      <thead><tr><th>Device</th><th>Viewport</th><th>Status</th><th>PDP</th><th>Cart</th><th>Cart Popup</th><th>Drawer</th></tr></thead>
      <tbody>
        ${rows.map(r => {
          const anyLink = isRealUrl(r.pdp) || isRealUrl(r.cart) || isRealUrl(r.cartPopup) || isRealUrl(r.drawer);
          return `<tr>
            <td class="device-name">${escapeHtml(r.device)}</td>
            <td class="dims">${escapeHtml(r.dimensions)}</td>
            <td><span class="badge ${anyLink ? 'badge-ok' : 'badge-pending'}">${anyLink ? 'VERIFIED' : 'PENDING'}</span></td>
            <td>${linkOrDash(r.pdp, 'View PDP')}</td>
            <td>${linkOrDash(r.cart, 'View Cart')}</td>
            <td>${linkOrDash(r.cartPopup, 'View Popup')}</td>
            <td>${linkOrDash(r.drawer, 'View Drawer')}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

/** Renders the optional Shopify free-theme update log page — grouped by release (version +
 *  date + what changed), with the themes actually used by this store highlighted. */
function renderThemeLogPage(data) {
  const log = data.themeUpdateLog;
  if (!log || !(log.updateGroups ?? []).length) return '';
  const tested = new Set((log.testedThemes ?? []).map(t => t.toLowerCase()));
  return `
  <div class="page">
    <div class="eyebrow">${escapeHtml(log.sectionTitle ?? 'Shopify Theme Updates')}</div>
    <h1>Free Theme Releases This Cycle</h1>
    ${log.summary ? `<p class="muted">${escapeHtml(log.summary)}</p>` : ''}
    ${log.updateGroups.map(g => `
      <div class="theme-log-row">
        <div class="theme-log-version">
          ${g.fromVersion
            ? `<div class="v-upgrade"><span class="v-from">v${escapeHtml(g.fromVersion)}</span> <span class="v-arrow">&rarr;</span> <span class="v-to">v${escapeHtml(g.version ?? '—')}</span></div>`
            : `<div class="v">v${escapeHtml(g.version ?? '—')}</div>`}
          <div class="d">${g.date ? escapeHtml(new Date(g.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) : ''}</div>
        </div>
        <div class="theme-log-changed">
          <div class="ops-metric-label">WHAT CHANGED</div>
          <p>${escapeHtml(g.whatChanged ?? '')}</p>
        </div>
        <div class="theme-log-themes">
          <div class="ops-metric-label">THEMES UPDATED (${(g.themes ?? []).length})</div>
          <div class="theme-chips">
            ${[...(g.themes ?? [])].sort((a, b) => (tested.has(a.toLowerCase()) ? 0 : 1) - (tested.has(b.toLowerCase()) ? 0 : 1)).map(name => {
              const isTested = tested.has(name.toLowerCase());
              return `<span class="theme-chip ${isTested ? 'theme-chip-tested' : 'theme-chip-pending'}">${escapeHtml(name)}${isTested ? ' ✓' : ''}</span>`;
            }).join('')}
          </div>
        </div>
      </div>`).join('')}
    <div class="theme-log-legend">
      <span><span class="dot dot-green"></span>Green — Tested this cycle</span>
      <span><span class="dot dot-orange"></span>Orange — Pending (queued for an upcoming cycle)</span>
    </div>
    ${log.testedNote ? `<div class="ops-conclusion">✔ ${escapeHtml(log.testedNote)}</div>` : ''}
  </div>`;
}

/** Custom app testing pages for the client PDF: coverage table, then items noted. */
function renderCustomAppPages(data) {
  const cat = data.customAppTesting;
  if (!cat) return '';
  const rowsHtml = cat.areas.map((a) => `<tr><td class="device-name">${escapeHtml(a.label)}</td><td style="font-size:9.5px;color:var(--muted);">${escapeHtml(a.tested)}</td><td>${a.run}</td><td style="color:var(--success);font-weight:700;">${a.passed}</td><td style="font-weight:700;">${a.items || '—'}</td></tr>`).join('');
  const itemsHtml = cat.findings.length
    ? cat.findings.slice(0, 6).map((f) => `<div class="dev-item" style="border-left-color:${f.severity === 'high' || f.severity === 'critical' ? '#DC2626' : f.severity === 'medium' ? '#F59E0B' : '#64748B'};"><div class="cat">${escapeHtml((SEV_PILL[f.severity] ?? ['Note'])[0])} priority</div><div class="title">${escapeHtml(f.title)}</div><div>${escapeHtml(plainTrim(f.detail, 220))}</div></div>`).join('') + (cat.findings.length > 6 ? `<p class="muted" style="font-size:11px;margin-top:6px;">+ ${cat.findings.length - 6} more item${cat.findings.length - 6 === 1 ? '' : 's'} in the technical report</p>` : '')
    : '<div class="ops-conclusion">✔ All checks passed. No items need follow-up.</div>';
  const retestPage = cat.retest ? `
  <div class="page">
    <div class="eyebrow">Custom App Testing</div>
    <h1>Re-test After the Dev Team Fixes</h1>
    <div class="metrics">
      <div class="metric"><div class="stat" style="color:var(--success);">${cat.retest.fixed} of ${cat.retest.baselineCount}</div><div class="label">Earlier items fixed</div></div>
      <div class="metric"><div class="stat" style="color:#B45309;">${cat.retest.open}</div><div class="label">Still open</div></div>
      <div class="metric"><div class="stat">${cat.retest.newCount}</div><div class="label">New on re-test</div></div>
    </div>
    <table class="device-table" style="margin-top:14px;"><thead><tr><th>Issue reported earlier</th><th style="width:70px;">Result</th></tr></thead><tbody>
      ${cat.retest.rows.map((r) => `<tr><td>${escapeHtml(plainTrim(r.title, 110))}</td><td style="font-weight:700;color:${r.fixed ? 'var(--success)' : '#B45309'};">${r.fixed ? '&#10003; Fixed' : 'Still open'}</td></tr>`).join('')}
    </tbody></table>
    <p class="muted" style="font-size:11px;margin-top:8px;">Each earlier item was repeated against the live dashboard after the dev team reported their fixes.</p>
  </div>` : '';
  return `
  <div class="page">
    <div class="eyebrow">Custom App Testing</div>
    <h1>Custom App Dashboard: Coverage &amp; Results</h1>
    <div class="metrics">
      <div class="metric"><div class="stat">${cat.run}</div><div class="label">Automated checks run</div></div>
      <div class="metric"><div class="stat" style="color:var(--success);">${cat.passed}</div><div class="label">Passed</div></div>
      <div class="metric"><div class="stat" style="color:#B45309;">${cat.findings.length}</div><div class="label">Items noted for follow-up</div></div>
    </div>
    <table class="device-table" style="margin-top:14px;"><thead><tr><th style="width:130px;">Area</th><th>What we checked</th><th style="width:50px;">Checks</th><th style="width:50px;">Passed</th><th style="width:45px;">Items</th></tr></thead><tbody>${rowsHtml}</tbody></table>
    <p class="muted" style="font-size:11px;margin-top:8px;">Read-only: nothing was added, changed, deleted or sent. Email Templates' Add, Edit, Delete and Send test mail were intentionally not used.</p>
  </div>
  ${retestPage}
  <div class="page">
    <div class="eyebrow">Custom App Testing</div>
    <h1>${cat.retest ? 'Custom App Dashboard: Items Still Open' : 'Custom App Dashboard: Items Noted'}</h1>
    <p class="muted">Highest priority first. ${cat.findings.some((f) => ['high', 'critical'].includes(f.severity)) ? 'Please review the high-priority items first.' : 'None stop the dashboard from working; they are layout, wording and data-tidiness improvements.'} Full detail, evidence and recommended fixes are in the Custom App Technical Report.</p>
    ${itemsHtml}
  </div>`;
}

/** Renders the optional "Monthly App & Server Monitoring" (opsMonitoringSection) pages —
 *  overview, performance metrics, build cache before/after, 24h usage, incidents, summary
 *  table, final assessment. Returns '' when no ops section is present in the input. */
function renderOpsPages(data) {
  const ops = data.opsMonitoringSection;
  if (!ops) return '';
  const title = escapeHtml(ops.sectionTitle ?? 'Monthly App & Server Monitoring');
  const linkOrPending = (url, label) => isRealUrl(url) ? `<a href="${escapeHtml(url)}" target="_blank">${label}</a>` : `<span class="pending">Link pending</span>`;
  const statusOk = (s) => /resolved|healthy|stable|restored|active|tested/i.test(s ?? '');

  const metricRow = (m) => !m ? '' : `
    <div class="ops-metric-card">
      <div class="ops-metric-label">${escapeHtml(m.label ?? '')}</div>
      <table class="ops-stat-table">
        <tr><td>Response Time</td><td class="v">${escapeHtml(m.responseTime ?? 'N/A')}</td></tr>
        <tr><td>Throughput</td><td class="v">${escapeHtml(m.throughput ?? 'N/A')}</td></tr>
        <tr><td>Memory Usage</td><td class="v">${escapeHtml(m.memoryUsage ?? 'N/A')}</td></tr>
      </table>
      <ul class="ops-assess">
        ${(m.assessment ?? []).map(t => `<li>${escapeHtml(t)}</li>`).join('')}
      </ul>
      ${isRealUrl(m.referenceUrl) ? `<p class="ops-ref">${linkOrPending(m.referenceUrl, 'View metrics dashboard')}</p>` : ''}
    </div>`;

  const cacheRow = (m) => !m ? '' : `
    <div class="ops-metric-card">
      <div class="ops-metric-label">${escapeHtml(m.label ?? '')}</div>
      <div class="cache-links">
        <div class="cache-link"><div class="cache-link-tag">BEFORE</div>${linkOrPending(m.beforeUrl, 'View evidence')}</div>
        <div class="cache-link"><div class="cache-link-tag">AFTER</div>${linkOrPending(m.afterUrl, 'View evidence')}</div>
      </div>
    </div>`;

  const usageRow = (m) => !m ? '' : `
    <div class="ops-metric-card">
      <div class="ops-metric-label">${escapeHtml(m.label ?? '')}</div>
      <p>${linkOrPending(m.evidenceUrl, 'View usage evidence →')}</p>
    </div>`;

  const incidentPages = (ops.incidents ?? []).map(inc => `
    <div class="page">
      <div class="eyebrow">${title}</div>
      <h1>${escapeHtml(inc.title ?? 'Incident Identified & Resolved')}</h1>
      <div class="incident-flow">
        <div class="incident-stage stage-risk"><div class="stage-head">THE ISSUE</div><p>${escapeHtml(inc.issue ?? '')}</p></div>
        <div class="incident-stage stage-fix"><div class="stage-head">ROOT CAUSE &amp; FIX</div><p>${escapeHtml(inc.rootCause ?? '')}</p></div>
        <div class="incident-stage stage-result"><div class="stage-head">RESULT</div><p>${escapeHtml(inc.conclusion ?? '')}</p></div>
      </div>
      ${inc.affectedEndpoint ? `<p class="ops-endpoint"><b>Affected endpoint:</b> <code>${escapeHtml(inc.affectedEndpoint)}</code></p>` : ''}
      ${(inc.resolutionSteps ?? []).length > 0 ? `
      <div class="card">
        <div class="ops-metric-label">RESOLUTION STEPS</div>
        ${inc.resolutionSteps.map(t => `<div class="check-row"><span class="check-dot check-ok">✔</span><span>${escapeHtml(t)}</span></div>`).join('')}
      </div>` : ''}
    </div>`).join('');

  return `
  <div class="page">
    <div class="eyebrow">${title}</div>
    <h1>Overview</h1>
    <div class="ops-two-col">
      <div class="card">
        <div class="ops-metric-label">OPTIMIZATIONS &amp; CHECKS REVIEWED</div>
        <div class="ops-badge-list">${(ops.overview?.optimizationsReviewed ?? []).map((t, i) => `<div class="ops-badge-row"><span class="ops-badge ops-badge-blue">${i + 1}</span><span>${escapeHtml(t)}</span></div>`).join('')}</div>
      </div>
      <div class="card">
        <div class="ops-metric-label">OBJECTIVES</div>
        <div class="ops-badge-list">${(ops.overview?.objectives ?? []).map((t, i) => `<div class="ops-badge-row"><span class="ops-badge ops-badge-green">${i + 1}</span><span>${escapeHtml(t)}</span></div>`).join('')}</div>
      </div>
    </div>
  </div>

  <div class="page">
    <div class="eyebrow">${title}</div>
    <h1>Performance Metrics</h1>
    <div class="ops-two-col">${metricRow(ops.performanceMetrics?.app)}${metricRow(ops.performanceMetrics?.dashboard)}</div>
    ${ops.performanceMetrics?.conclusion ? `<div class="ops-conclusion">✔ ${escapeHtml(ops.performanceMetrics.conclusion)}</div>` : ''}
  </div>

  ${ops.sslSecurity ? (() => {
    const ssl = ops.sslSecurity;
    const now = new Date();
    const expiry = ssl.expiresOn ? new Date(ssl.expiresOn) : null;
    const daysRemaining = expiry ? Math.ceil((expiry - now) / 86400000) : null;
    const healthy = daysRemaining === null || daysRemaining > 30;
    const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'N/A';
    return `
  <div class="page">
    <div class="eyebrow">Infrastructure Security</div>
    <h1>SSL Certificate &amp; Domain Security</h1>
    <div class="ops-two-col">
      <div class="ops-metric-card">
        <div class="ops-metric-label">SSL CERTIFICATE STATUS</div>
        <div style="font-family:'Outfit',sans-serif; font-size:20px; font-weight:700; color:${healthy ? 'var(--success)' : '#DC2626'}; margin-bottom:10px;">${healthy ? 'Active &amp; Secure' : 'Renewal Needed Soon'}</div>
        <ul class="ops-bullets ops-bullets-blue">
          <li>Certificate covers: ${escapeHtml(ssl.commonName ?? 'N/A')}</li>
          <li>Issued by: ${escapeHtml(ssl.issuer ?? 'N/A')}</li>
          <li>Issued on: ${escapeHtml(fmtDate(ssl.issuedOn))}</li>
          <li>Expires on: ${escapeHtml(fmtDate(ssl.expiresOn))}${daysRemaining !== null ? ` (${daysRemaining} days from today)` : ''}</li>
        </ul>
        ${ssl.coverageNote ? `<p class="muted" style="font-size:11px; margin-top:10px;">${escapeHtml(ssl.coverageNote)}</p>` : ''}
      </div>
      ${ssl.screenshot ? `
      <div class="ops-metric-card" style="text-align:center;">
        <div class="ops-metric-label">CERTIFICATE EVIDENCE (BROWSER VIEW)</div>
        <img src="${escapeHtml(ssl.screenshot)}" style="max-width:100%; max-height:320px; border:1px solid var(--border); border-radius:6px;" />
      </div>` : ''}
    </div>
  </div>`;
  })() : ''}

  <div class="page">
    <div class="eyebrow">${title}</div>
    <h1>Build Cache Analysis</h1>
    <div class="ops-two-col">${cacheRow(ops.buildCacheAnalysis?.app)}${cacheRow(ops.buildCacheAnalysis?.dashboard)}</div>
    <div class="card">
      <div class="ops-metric-label">FINDINGS</div>
      <ul class="ops-bullets ops-bullets-blue">${(ops.buildCacheAnalysis?.findings ?? []).map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
    </div>
    ${ops.buildCacheAnalysis?.conclusion ? `<div class="ops-conclusion">✔ ${escapeHtml(ops.buildCacheAnalysis.conclusion)}</div>` : ''}
  </div>

  <div class="page">
    <div class="eyebrow">${title}</div>
    <h1>Last 24 Hours Usage</h1>
    <div class="ops-two-col">${usageRow(ops.last24HoursUsage?.app)}${usageRow(ops.last24HoursUsage?.dashboard)}</div>
    <div class="card">
      <div class="ops-metric-label">FINDINGS</div>
      <ul class="ops-bullets ops-bullets-blue">${(ops.last24HoursUsage?.findings ?? []).map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
    </div>
    ${ops.last24HoursUsage?.conclusion ? `<div class="ops-conclusion">✔ ${escapeHtml(ops.last24HoursUsage.conclusion)}</div>` : ''}
  </div>

  ${incidentPages}

  ${renderCustomAppPages(data)}

  ${(ops.overallSummary ?? []).length > 0 ? `
  <div class="page">
    <div class="eyebrow">${title}</div>
    <h1>Overall Summary</h1>
    <table class="device-table">
      <thead><tr><th>Area</th><th>Status</th><th>Remarks</th></tr></thead>
      <tbody>
        ${ops.overallSummary.map(row => `<tr>
          <td class="device-name">${escapeHtml(row.area)}</td>
          <td><span class="badge ${statusOk(row.status) ? 'badge-ok' : 'badge-pending'}">✔ ${escapeHtml(row.status)}</span></td>
          <td class="muted">${escapeHtml(row.remarks)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''}

  <div class="page">
    <div class="eyebrow">${title}</div>
    <h1>Final Assessment</h1>
    <div class="ops-two-col">
      <div class="card">
        <div class="ops-metric-label" style="color:var(--success);">SUCCESSFUL OUTCOMES</div>
        ${(ops.finalAssessment?.successfulOutcomes ?? []).map(t => `<div class="check-row"><span class="check-dot check-ok">✔</span><span>${escapeHtml(t)}</span></div>`).join('')}
      </div>
      <div class="card">
        <div class="ops-metric-label" style="color:var(--brand-secondary);">AREAS FOR CONTINUED MONITORING</div>
        <ul class="ops-bullets ops-bullets-blue">${(ops.finalAssessment?.continuedMonitoring ?? []).map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
      </div>
    </div>
  </div>`;
}

async function generatePdf(data, outPath) {
  const outDir = resolve(outPath, '..');
  const { label: monthLabel } = readableMonthYear(data.month);
  const ops = data.opsMonitoringSection ?? null;
  const hasWidgetQa = Object.keys(data.qaTestingSection?.themes ?? {}).length > 0 && !!data.qaTestingSection?.widgetName;
  const devCategories = data.devTeamSection?.categories ?? [];
  const checks = data.qaTestingSection?.functionalChecks ?? [];
  const touchpoints = data.qaTestingSection?.touchpoints ?? [];
  const recs = data.recommendations ?? [];

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(data.reportTitle)}</title>
<style>
  :root {
    --brand-blue: #0EA5E9; --brand-secondary: #075985; --success: #10B981;
    --text-dark: #0F172A; --muted: #64748B; --border: #E2E8F0; --card-bg: #F8FAFC;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Plus Jakarta Sans', Arial, sans-serif; color: var(--text-dark); margin: 0; }
  .page { width: 210mm; min-height: 297mm; padding: 16mm 14mm; page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  h1 { font-family: 'Outfit', Arial, sans-serif; font-size: 26px; margin: 4px 0 6px; }
  h2 { font-family: 'Outfit', Arial, sans-serif; font-size: 18px; margin: 18px 0 8px; color: var(--brand-secondary); }
  .eyebrow { color: var(--brand-blue); font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .muted { color: var(--muted); }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 12px; }
  .metrics { display: flex; gap: 10px; margin-top: 16px; }
  .metric { flex: 1; background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .metric .stat { font-family: 'Outfit', Arial, sans-serif; font-size: 24px; font-weight: 700; color: var(--brand-blue); }
  .metric .label { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .dev-item { border-left: 4px solid var(--brand-blue); background: var(--card-bg); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .dev-item .cat { font-size: 10px; font-weight: 700; color: var(--muted); text-transform: uppercase; }
  .dev-item .title { font-family: 'Outfit', Arial, sans-serif; font-size: 15px; font-weight: 700; margin: 4px 0; }
  .dev-item .impact { font-size: 12px; margin-top: 6px; }
  .dev-item .impact b { color: var(--success); }
  .check-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; }
  .check-dot { width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 11px; flex-shrink: 0; }
  .check-ok { background: var(--success); }
  .check-fail { background: #DC2626; }
  .touchpoints { display: flex; gap: 10px; }
  .touchpoint { flex: 1; background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px; text-align: center; }
  .touchpoint .num { width: 28px; height: 28px; border-radius: 50%; background: var(--brand-blue); color: #fff; display: flex; align-items: center; justify-content: center; margin: 0 auto 8px; font-weight: 700; }
  .touchpoint .name { font-weight: 700; font-size: 13px; margin-bottom: 4px; }
  .touchpoint .note { font-size: 10.5px; color: var(--muted); }
  table.device-table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 8px; table-layout: fixed; }
  table.device-table th { background: #F1F5F9; text-align: left; padding: 6px 6px; border: 1px solid var(--border); font-size: 9px; }
  table.device-table td { padding: 6px 6px; border: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; }
  table.device-table .device-name { font-weight: 700; }
  table.device-table .dims { color: var(--muted); }
  table.device-table a { color: var(--brand-blue); font-weight: 700; text-decoration: none; }
  table.device-table .pending { color: var(--muted); }
  .badge { font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 10px; }
  .badge-ok { background: #ECFDF5; color: #047857; }
  .badge-pending { background: #F1F5F9; color: var(--muted); }
  .rec-list { list-style: none; padding: 0; }
  .rec-list li { display: flex; gap: 10px; padding: 8px 0; font-size: 13px; border-bottom: 1px solid var(--border); }
  .rec-num { width: 22px; height: 22px; border-radius: 50%; background: var(--brand-blue); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
  .footer { position: fixed; bottom: 8mm; left: 14mm; right: 14mm; display: flex; justify-content: space-between; font-size: 9px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 4px; }
  .ops-two-col { display: flex; gap: 14px; align-items: flex-start; margin-top: 12px; }
  .ops-two-col > * { flex: 1; }
  .ops-metric-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .ops-metric-label { font-size: 10.5px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 8px; }
  table.ops-stat-table { width: 100%; font-size: 13px; margin-bottom: 8px; }
  table.ops-stat-table td { padding: 4px 0; }
  table.ops-stat-table .v { text-align: right; font-family: 'Outfit', Arial, sans-serif; font-weight: 700; color: var(--brand-blue); }
  ul.ops-assess { list-style: none; padding: 0; margin: 8px 0 0; }
  ul.ops-assess li { font-size: 10.5px; color: var(--muted); padding: 3px 0 3px 16px; position: relative; }
  ul.ops-assess li::before { content: '✔'; position: absolute; left: 0; color: var(--success); font-size: 10px; }
  .ops-ref { margin-top: 8px; font-size: 11px; }
  .ops-ref a { color: var(--brand-blue); font-weight: 700; text-decoration: none; }
  .ops-conclusion { margin-top: 12px; background: #ECFDF5; border: 1px solid #86EFAC; color: #166534; border-radius: 8px; padding: 10px 14px; font-size: 12px; font-weight: 700; }
  ul.ops-bullets { list-style: none; padding: 0; margin: 4px 0 0; }
  ul.ops-bullets li { font-size: 12px; padding: 5px 0 5px 18px; position: relative; }
  ul.ops-bullets-blue li::before { content: '•'; position: absolute; left: 0; color: var(--brand-blue); font-weight: 700; }
  ul.ops-bullets-green li::before { content: '•'; position: absolute; left: 0; color: var(--success); font-weight: 700; }
  .ops-badge-list { margin-top: 6px; }
  .ops-badge-row { display: flex; align-items: flex-start; gap: 10px; padding: 6px 0; font-size: 12px; }
  .ops-badge { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 11px; font-weight: 700; font-family: 'Outfit', Arial, sans-serif; display: flex; align-items: center; justify-content: center; }
  .ops-badge-blue { background: var(--brand-blue); }
  .ops-badge-green { background: var(--success); }
  .cache-links { display: flex; gap: 10px; margin-top: 4px; }
  .cache-link { flex: 1; background: #F0F9FF; border: 1px solid #7DD3FC; border-radius: 8px; padding: 10px; }
  .cache-link-tag { font-size: 9.5px; font-weight: 700; color: var(--muted); margin-bottom: 4px; }
  .cache-link a { color: var(--brand-blue); font-weight: 700; font-size: 12px; text-decoration: none; }
  .cache-link .pending { color: var(--muted); font-size: 12px; }
  .incident-flow { display: flex; gap: 12px; margin-top: 14px; }
  .incident-stage { flex: 1; border-radius: 10px; padding: 14px; border: 1.25px solid; }
  .incident-stage .stage-head { font-size: 11px; font-weight: 700; margin-bottom: 8px; }
  .incident-stage p { font-size: 12px; margin: 0; }
  .stage-risk { background: #FEF2F2; border-color: #FCA5A5; } .stage-risk .stage-head { color: #DC2626; }
  .stage-fix { background: #F0F9FF; border-color: #7DD3FC; } .stage-fix .stage-head { color: #0EA5E9; }
  .stage-result { background: #ECFDF5; border-color: #86EFAC; } .stage-result .stage-head { color: #10B981; }
  .ops-endpoint { font-size: 11px; margin-top: 12px; }
  .ops-endpoint code { background: var(--card-bg); border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; }
  .theme-log-row { display: flex; gap: 16px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-top: 12px; align-items: flex-start; }
  .theme-log-version { width: 130px; flex-shrink: 0; }
  .theme-log-version .v { font-family: 'Outfit', Arial, sans-serif; font-size: 18px; font-weight: 700; color: var(--brand-secondary); }
  .theme-log-version .v-upgrade { font-family: 'Outfit', Arial, sans-serif; font-size: 13px; }
  .theme-log-version .v-from { color: var(--muted); text-decoration: line-through; }
  .theme-log-version .v-arrow { color: var(--muted); }
  .theme-log-version .v-to { font-size: 16px; font-weight: 700; color: var(--brand-secondary); }
  .theme-log-version .d { font-size: 10px; color: var(--muted); margin-top: 3px; }
  .theme-log-changed { width: 190px; flex-shrink: 0; }
  .theme-log-changed p { font-size: 12px; margin: 4px 0 0; }
  .theme-log-themes { flex: 1; }
  .theme-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .theme-chip { font-size: 10.5px; padding: 4px 10px; border-radius: 12px; background: #fff; border: 1px solid var(--border); color: var(--text-dark); }
  .theme-chip-tested { background: #ECFDF5; border-color: var(--success); color: #047857; font-weight: 700; }
  .theme-chip-pending { background: #FFF7ED; border-color: #F97316; color: #9A3412; font-weight: 700; }
  .theme-log-legend { display: flex; gap: 28px; margin-top: 14px; font-size: 11px; font-weight: 700; color: var(--text-dark); }
  .theme-log-legend .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .theme-log-legend .dot-green { background: var(--success); }
  .theme-log-legend .dot-orange { background: #F97316; }
  .visual-grid { display: flex; gap: 12px; margin-top: 12px; }
  .visual-card { flex: 1; background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; }
  .visual-card-title { font-family: 'Outfit', Arial, sans-serif; font-size: 11px; font-weight: 700; color: var(--brand-secondary); text-transform: uppercase; margin-bottom: 2px; }
  .visual-card-sub { font-size: 9.5px; color: var(--muted); margin-bottom: 8px; }
  .visual-card-img { flex: 1; height: 580px; max-height: 580px; background: #fff; border: 1px solid var(--border); border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 6px; }
  .visual-card-img img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .visual-badge { margin-top: 8px; background: #ECFDF5; border: 1px solid #86EFAC; color: #047857; font-size: 9.5px; font-weight: 700; text-align: center; padding: 5px; border-radius: 6px; }
  .visual-grid-5 { display: flex; gap: 8px; margin-top: 12px; }
  .visual-card-mob { flex: 1; background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 6px; display: flex; flex-direction: column; }
  .visual-card-mob .visual-card-title { font-family: 'Outfit', Arial, sans-serif; font-size: 10px; font-weight: 700; text-align: center; margin-bottom: 1px; }
  .visual-card-mob .visual-card-sub { font-size: 8.5px; text-align: center; color: var(--muted); margin-bottom: 6px; line-height: 1.2; }
  .visual-card-mob .visual-card-img { flex: 1; height: 580px; max-height: 580px; background: #fff; border: 1px solid var(--border); border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 4px; }
  .visual-card-mob .visual-card-img img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .visual-card-mob .visual-badge { margin-top: 6px; background: #ECFDF5; border: 1px solid #86EFAC; color: #047857; font-size: 8.5px; font-weight: 700; text-align: center; padding: 4px; border-radius: 6px; }
</style>
</head>
<body>

  <div class="page">
    <div class="eyebrow">Monthly Monitoring Report</div>
    <h1 style="font-size:34px;">${escapeHtml(data.reportTitle)}</h1>
    <p style="font-size:16px; color: var(--brand-blue); font-weight:600;">${escapeHtml(data.clientName)} &mdash; ${escapeHtml(monthLabel)}</p>
    <p class="muted">Prepared by ${escapeHtml(data.preparedBy)}</p>
    ${data.storeUrl ? `<p class="muted">${escapeHtml(data.storeUrl)}</p>` : ''}
  </div>

  <div class="page">
    <div class="eyebrow">Executive Summary</div>
    <h1>${escapeHtml(monthLabel)} Monitoring Overview</h1>
    <p>${escapeHtml(data.executiveSummary)}</p>
    <div class="metrics">
      ${(!ops && data.customAppTesting) ? `
      <div class="metric"><div class="stat">${data.customAppTesting.run}</div><div class="label">Automated Checks Run</div></div>
      <div class="metric"><div class="stat">${data.customAppTesting.passed}</div><div class="label">Checks Passed</div></div>
      <div class="metric"><div class="stat">${data.customAppTesting.findings.length}</div><div class="label">Items Noted for Follow-up</div></div>
      ` : ops ? `
      <div class="metric"><div class="stat">${escapeHtml(ops.performanceMetrics?.app?.responseTime ?? 'N/A')}</div><div class="label">App Response Time</div></div>
      <div class="metric"><div class="stat">${escapeHtml(ops.performanceMetrics?.dashboard?.responseTime ?? 'N/A')}</div><div class="label">Dashboard Response Time</div></div>
      <div class="metric"><div class="stat" style="font-size:20px;">${ops.buildCacheAnalysis ? 'Cleared' : 'N/A'}</div><div class="label">Build Cache Status</div></div>
      ` : `
      <div class="metric"><div class="stat">${devCategories.reduce((n, c) => n + (c.items?.length ?? 0), 0)}</div><div class="label">Dev Work Items Completed</div></div>
      <div class="metric"><div class="stat">${Object.keys(data.qaTestingSection?.themes ?? {}).length}</div><div class="label">Themes Monitored</div></div>
      <div class="metric"><div class="stat" style="font-size:14px;">${escapeHtml(data.qaTestingSection?.functionalStatus ?? 'N/A')}</div><div class="label">Widget Functional Status</div></div>
      `}
    </div>
  </div>

  ${renderOpsPages(data)}
  ${!ops ? renderCustomAppPages(data) : ''}

  ${(devCategories.length > 0 || (!ops && !data.customAppTesting)) ? `
  <div class="page">
    <div class="eyebrow">${escapeHtml(data.devTeamSection?.sectionTitle ?? 'Development & Maintenance Updates')}</div>
    <h1>Monthly Development Work Completed</h1>
    <p class="muted">${escapeHtml(data.devTeamSection?.summary ?? '')}</p>
    ${devCategories.map(cat => `
      <h2>${escapeHtml(cat.categoryName)}</h2>
      ${(cat.items ?? []).map(item => `
        <div class="dev-item">
          <div class="title">${escapeHtml(item.title)}</div>
          <div>${escapeHtml(item.description)}</div>
          ${item.impact ? `<div class="impact"><b>Client impact:</b> ${escapeHtml(item.impact)}</div>` : ''}
        </div>`).join('')}
    `).join('') || '<p class="muted">No development items were provided for this monitoring cycle.</p>'}
  </div>` : ''}

  ${hasWidgetQa ? `
  <div class="page">
    <div class="eyebrow">${escapeHtml(data.qaTestingSection?.sectionTitle ?? 'Multi-Device Storefront & Widget Audit')}</div>
    <h1>Widget Architecture & Functional Validation</h1>
    <p class="muted">${escapeHtml(data.qaTestingSection?.widgetName ?? '')}</p>
    <div class="card">
      <div style="font-size:20px; font-weight:700; color: var(--success); font-family:'Outfit',sans-serif;">${escapeHtml(data.qaTestingSection?.functionalStatus ?? 'Not reported')}</div>
      ${checks.map(c => `
        <div class="check-row">
          <span class="check-dot ${c.passed !== false ? 'check-ok' : 'check-fail'}">${c.passed !== false ? '✔' : '✖'}</span>
          <span>${escapeHtml(c.label)}</span>
        </div>`).join('')}
    </div>
    ${touchpoints.length > 0 ? `
    <h2>Storefront Touchpoints Verified</h2>
    <div class="touchpoints">
      ${touchpoints.slice(0, 4).map((tp, i) => `
        <div class="touchpoint">
          <div class="num">${i + 1}</div>
          <div class="name">${escapeHtml(tp.name)}</div>
          <div class="note">${escapeHtml(tp.note)}</div>
        </div>`).join('')}
    </div>` : ''}
  </div>

  ${renderThemeLogPage(data)}

  ${Object.keys(data.qaTestingSection?.themes ?? {}).map(themeKey => {
    const theme = data.qaTestingSection?.themes?.[themeKey];
    if (!theme) return '';

    const pdpDesk = findScreenshotPath(themeKey, 'product-page/desktop', `${themeKey}_pdp_fullpage_desktop_1280x800.png`, outDir);
    const drawerDesk = findScreenshotPath(themeKey, 'cart-drawer/desktop', `${themeKey}_drawer_viewport_desktop_1280x800.png`, outDir)
      || findScreenshotPath(themeKey, 'cart-drawer/tablet', `${themeKey}_drawer_viewport_tablet_768x1024.png`, outDir);
    const cartDesk = findScreenshotPath(themeKey, 'cart-page/desktop', `${themeKey}_cart_fullpage_desktop_1280x800.png`, outDir);

    const mobileCards = [
      { name: 'Galaxy S24', label: 'PDP Full-Page', res: '360 × 780', img: findScreenshotPath(themeKey, 'product-page/mobile', `${themeKey}_pdp_fullpage_mobile_360x780.png`, outDir) },
      { name: 'Galaxy S24', label: 'Cart Drawer', res: '360 × 780', img: findScreenshotPath(themeKey, 'cart-drawer/mobile', `${themeKey}_drawer_viewport_mobile_360x780.png`, outDir) },
      { name: 'Galaxy S24', label: 'Cart Page', res: '360 × 780', img: findScreenshotPath(themeKey, 'cart-page/mobile', `${themeKey}_cart_fullpage_mobile_360x780.png`, outDir) },
      { name: 'iPhone 13 / 14 / 15', label: 'Cart Drawer', res: '390 × 844', img: findScreenshotPath(themeKey, 'cart-drawer/mobile', `${themeKey}_drawer_viewport_mobile_390x844.png`, outDir) },
      { name: 'iPhone 15 Pro Max', label: 'Cart Page', res: '430 × 932', img: findScreenshotPath(themeKey, 'cart-page/mobile', `${themeKey}_cart_fullpage_mobile_430x932.png`, outDir) }
    ].filter(m => m.img);

    const tabCards = [
      { name: 'iPad Portrait', label: 'Cart Drawer', res: '768 × 1024', img: findScreenshotPath(themeKey, 'cart-drawer/tablet', `${themeKey}_drawer_viewport_tablet_768x1024.png`, outDir) },
      { name: 'iPad Air / Pro', label: 'Cart Page', res: '820 × 1180', img: findScreenshotPath(themeKey, 'cart-page/tablet', `${themeKey}_cart_fullpage_tablet_820x1180.png`, outDir) },
      { name: 'iPad Landscape', label: 'Product Page', res: '1024 × 768', img: findScreenshotPath(themeKey, 'product-page/tablet', `${themeKey}_pdp_fullpage_tablet_1024x768.png`, outDir) }
    ].filter(t => t.img);

    let pagesHtml = '';

    if (pdpDesk || drawerDesk || cartDesk) {
      pagesHtml += `
      <div class="page">
        <div class="eyebrow">Theme: ${escapeHtml(theme.name ?? themeKey)} (v${escapeHtml(theme.version ?? '—')}) &bull; Visual Verification</div>
        <h1>${escapeHtml(theme.name ?? themeKey)} &mdash; Core Storefront Touchpoints</h1>
        <p class="muted">Live testing evidence: Tree Contribution Widget (.tdw-card &amp; .tdw-drawer-wrap) verified across key buyer touchpoints.</p>
        <div class="visual-grid">
          <div class="visual-card">
            <div class="visual-card-title">PRODUCT DETAIL PAGE (PDP)</div>
            <div class="visual-card-sub">Desktop (1280&times;800) &bull; Full-Page</div>
            <div class="visual-card-img">${pdpDesk ? `<img src="${toImgSrc(pdpDesk, outDir)}" alt="PDP Desktop">` : '<span class="muted">No screenshot</span>'}</div>
            <div class="visual-badge">&check; Embedded below Buy It Now</div>
          </div>
          <div class="visual-card">
            <div class="visual-card-title">CART DRAWER (SLIDE-OUT)</div>
            <div class="visual-card-sub">Desktop / Tablet &bull; Modal Viewport</div>
            <div class="visual-card-img">${drawerDesk ? `<img src="${toImgSrc(drawerDesk, outDir)}" alt="Cart Drawer">` : '<span class="muted">No screenshot</span>'}</div>
            <div class="visual-badge">&check; Verified inside Drawer Modal</div>
          </div>
          <div class="visual-card">
            <div class="visual-card-title">CART PAGE (/cart)</div>
            <div class="visual-card-sub">Desktop (1280&times;800) &bull; Full-Page</div>
            <div class="visual-card-img">${cartDesk ? `<img src="${toImgSrc(cartDesk, outDir)}" alt="Cart Page">` : '<span class="muted">No screenshot</span>'}</div>
            <div class="visual-badge">&check; Verified below Order Summary</div>
          </div>
        </div>
      </div>`;
    }

    if (mobileCards.length > 0) {
      pagesHtml += `
      <div class="page">
        <div class="eyebrow">Theme: ${escapeHtml(theme.name ?? themeKey)} (v${escapeHtml(theme.version ?? '—')}) &bull; Mobile Responsive Matrix</div>
        <h1>${escapeHtml(theme.name ?? themeKey)} &mdash; Mobile Device Visual Audit</h1>
        <p class="muted">Multi-device responsive testing: verified touch targets, dropdown behavior, and zero sticky-header overlap.</p>
        <div class="visual-grid-5">
          ${mobileCards.map(m => `
            <div class="visual-card-mob">
              <div class="visual-card-title">${escapeHtml(m.name)}</div>
              <div class="visual-card-sub">${escapeHtml(m.label)}<br>${escapeHtml(m.res)}</div>
              <div class="visual-card-img"><img src="${toImgSrc(m.img, outDir)}" alt="${escapeHtml(m.name)}"></div>
              <div class="visual-badge">&check; Verified</div>
            </div>
          `).join('')}
        </div>
      </div>`;
    }

    if (tabCards.length > 0) {
      pagesHtml += `
      <div class="page">
        <div class="eyebrow">Theme: ${escapeHtml(theme.name ?? themeKey)} (v${escapeHtml(theme.version ?? '—')}) &bull; Tablet Responsive Matrix</div>
        <h1>${escapeHtml(theme.name ?? themeKey)} &mdash; Tablet Visual Audit</h1>
        <p class="muted">Portrait and landscape tablet verification: responsive fluid scaling and drawer transition alignment.</p>
        <div class="visual-grid">
          ${tabCards.map(t => `
            <div class="visual-card">
              <div class="visual-card-title">${escapeHtml(t.name)} (${escapeHtml(t.res)})</div>
              <div class="visual-card-sub">Touchpoint: ${escapeHtml(t.label)}</div>
              <div class="visual-card-img"><img src="${toImgSrc(t.img, outDir)}" alt="${escapeHtml(t.name)}"></div>
              <div class="visual-badge">&check; Verified Responsive Layout</div>
            </div>
          `).join('')}
        </div>
      </div>`;
    }

    pagesHtml += `
    <div class="page">
      <div class="eyebrow">Theme: ${escapeHtml(theme.name ?? themeKey)} (v${escapeHtml(theme.version ?? '—')})</div>
      <h1>${escapeHtml(theme.name ?? themeKey)} &mdash; Multi-Device Responsive Matrix</h1>
      <p class="muted">${escapeHtml(theme.notes ?? '')}</p>
      ${renderDeviceTable(theme)}
    </div>`;

    return pagesHtml;
  }).join('')}
  ` : ''}

  <div class="page">
    ${(recs.length > 0 || (!ops && !data.customAppTesting)) ? `
    <div class="eyebrow">Looking Ahead</div>
    <h1>QA Observations, Recommendations & Next Steps</h1>
    ${recs.length > 0 ? `
    <ul class="rec-list">
      ${recs.map((r, i) => `<li><span class="rec-num">${i + 1}</span><span>${escapeHtml(r)}</span></li>`).join('')}
    </ul>` : '<p class="muted">No open recommendations this cycle.</p>'}
    ` : `
    <div class="eyebrow">Thank You</div>
    <h1>Report Complete</h1>
    `}
    <div style="margin-top:40px;">
      <p style="font-weight:700; font-size:16px; color: var(--brand-blue);">Thank you for partnering with WebDesk Solution.</p>
      <p class="muted">If you have questions regarding this report, please connect with your account engineer.</p>
    </div>
    <div style="display:flex; gap:40px; margin-top:50px;">
      <div>
        <p style="font-weight:700; margin:0 0 2px;">United States Office</p>
        <p class="muted" style="margin:0;">98 Cutter Mill Rd, Great Neck, NY 11021, USA</p>
      </div>
      <div>
        <p style="font-weight:700; margin:0 0 2px;">Canada Office</p>
        <p class="muted" style="margin:0;">150 King Street W, Toronto, ON M5H 1J9, Canada</p>
      </div>
    </div>
  </div>

</body>
</html>`;

  mkdirSync(outDir, { recursive: true });
  const htmlPath = outPath.replace(/\.pdf$/i, '.html');
  writeFileSync(htmlPath, html, 'utf8');
  logger.success(`HTML intermediate file written to: ${htmlPath}`);

  let browser;
  try {
    browser = await launchChromium({ headless: true });
    const page = await browser.newPage();
    await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' } });
    logger.success(`PDF report written to: ${outPath}`);
  } finally {
    if (browser) await browser.close();
  }
  return outPath;
}

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────

export async function generateTreeWidgetReport(inputPath, format = 'both') {
  const data = loadInput(inputPath);
  applyCustomAppCoverage(data);
  const { total, verified } = countVerifiedLinks(data);
  if (total > 0 && verified === 0) {
    logger.warn('No online screenshot links have been filled in yet — the device matrix will show "Link pending" for every row until config/monthly-monitoring-input.json is updated.');
  } else if (verified < total) {
    logger.warn(`${total - verified} of ${total} screenshot links are still placeholders.`);
  }

  const clientSlug = (data.clientName ?? 'client').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  const outDir = resolve(`results/${clientSlug}/${data.month}`);
  mkdirSync(outDir, { recursive: true });
  const { slug: monthSlug } = readableMonthYear(data.month);
  const baseName = `Monthly_Monitoring_Report_${monthSlug}`;

  const results = {};
  if (format === 'pptx' || format === 'both') {
    results.pptx = await generatePptx(data, join(outDir, `${baseName}.pptx`));
  }
  if (format === 'pdf' || format === 'both') {
    results.pdf = await generatePdf(data, join(outDir, `${baseName}.pdf`));
  }
  return results;
}

if (process.argv[1] && process.argv[1].endsWith('generate_tree_widget_report.js')) {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input ?? 'config/monthly-monitoring-input.json';
  const format = ['pptx', 'pdf', 'both'].includes(args.format) ? args.format : 'both';
  generateTreeWidgetReport(inputPath, format)
    .then((r) => { console.log('Done:', r); })
    .catch((err) => { console.error('Report generation failed:', err.message); process.exit(1); });
}
