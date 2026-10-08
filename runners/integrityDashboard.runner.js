import { launchChromium } from '../lib/browser.js';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../lib/logger.js';
import { createFinding, createRunnerResult, SEVERITY, CATEGORY } from '../lib/result.js';

const RUNNER = 'integrity_dashboard';
const POPOVER = 'div[class*="z-[9999]"]';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const num = (s) => {
  const n = parseFloat(String(s ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const lc = (s) => norm(s).toLowerCase();

/**
 * Read-only QA coverage of the Integrity Reforestation admin dashboard (custom app):
 * Dashboard, Stores Listing (+ store detail via View), Email Templates, Email Logs.
 *
 * Safety model (stronger than the generic customapp runner, because this one clicks):
 *   - Only page.goto(), filters, search, pagination, date pickers, the per-store "View"
 *     action and the email-log row "View" item are ever used.
 *   - After login every non-GET request is ABORTED in the browser before it leaves, and
 *     reported as a CRITICAL finding. Nothing is ever whitelisted.
 *   - Email Templates' Edit / Delete / Send test mail / ADD NEW are never clicked.
 *   - No screenshots or recipient e-mail addresses are written to the archive.
 *
 * Never throws — a failing check is recorded as 'error' and the pass keeps going.
 *
 * @param {Object} config - parsed config/integrity-dashboard.json
 * @param {string} [month] - YYYY-MM archive month
 * @param {{ sessionPath?: string }} [opts]
 * @returns {Promise<Object>} runner result envelope
 */
export async function runIntegrityDashboard(config, month = null, opts = {}) {
  const findings = [];
  const checks = [];
  const blocked = [];
  const apiErrors = new Set();
  const consoleErrors = new Set();
  const metrics = { baseUrl: config.baseUrl, month, checks, stores: {}, emails: {}, emailLogs: {}, dashboard: {} };

  const username = process.env[config.auth.usernameEnvVar];
  const password = process.env[config.auth.passwordEnvVar];
  if (!username || !password) {
    findings.push(createFinding({
      id: 'integrity-dashboard-no-credentials', runner: RUNNER, category: CATEGORY.CUSTOM_APP, severity: SEVERITY.INFO,
      title: 'Dashboard checks skipped — no login configured',
      detail: 'The login for the custom app dashboard is missing, so none of the dashboard checks could run.',
      evidence: `Environment variables checked: ${config.auth.usernameEnvVar}, ${config.auth.passwordEnvVar}`,
      recommendation: `Add ${config.auth.usernameEnvVar} and ${config.auth.passwordEnvVar} to .env.`
    }));
    return createRunnerResult(RUNNER, config.baseUrl, findings, metrics);
  }

  const sessionPath = opts.sessionPath ?? `.cache/customapp-sessions/${new URL(config.baseUrl).hostname}.json`;
  mkdirSync(dirname(sessionPath), { recursive: true });

  let browser;
  try {
    browser = await launchChromium({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ...(existsSync(sessionPath) ? { storageState: sessionPath } : {})
    });
    const page = await context.newPage();

    // ── Preventive write guard (armed after login) ────────────────────────
    let armed = false;
    await page.route('**/*', (route) => {
      const req = route.request();
      if (armed && !READ_METHODS.has(req.method())) {
        blocked.push(`${req.method()} ${req.url()}`);
        return route.abort();
      }
      return route.continue();
    });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.add(`${new URL(page.url()).pathname}: ${m.text().slice(0, 140)}`); });
    page.on('response', (r) => {
      const u = r.url();
      if (u.includes('/api/') && r.status() >= 400 && !u.includes('/api/auth/')) apiErrors.add(`${r.status()} ${u.replace(config.baseUrl, '').slice(0, 120)}`);
    });

    // ── helpers ───────────────────────────────────────────────────────────
    const settle = async () => { await page.waitForLoadState('networkidle').catch(() => null); await page.waitForTimeout(600); };
    const rows = () => page.$$eval('table tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.innerText.trim().replace(/\s+/g, ' '))));
    const rowCount = () => page.locator('table tbody tr').count();
    const headers = (i = 0) => page.$$eval('table', (ts, idx) => [...(ts[idx]?.querySelectorAll('thead th') ?? [])].map((t) => t.innerText.trim().replace(/\s+/g, ' ')), i);
    const pageInfo = () => page.evaluate(() => {
      const t = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /page\s*\d+\s*of\s*\d+/i.test(e.innerText || '')).map((e) => e.innerText.trim());
      const m = (t[0] || '').match(/(\d+)\s*of\s*(\d+)/i);
      return m ? { page: +m[1], pages: +m[2] } : null;
    });
    const bodyHas = async (text) => (await page.evaluate(() => document.body.innerText)).toLowerCase().includes(text.toLowerCase());
    const goto = async (path) => { await page.goto(config.baseUrl + path, { waitUntil: 'networkidle' }); await page.waitForTimeout(400); };
    const selectOptions = (i) => page.locator('select').nth(i).evaluate((s) => [...s.options].map((o) => o.text.trim()));
    const setPageSize = async (size) => { await page.locator('select').last().selectOption({ label: String(size) }); await settle(); };
    const kpis = (labels) => page.evaluate((ls) => {
      const out = {};
      for (const l of ls) {
        const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.innerText?.trim() === l);
        const t = (el?.parentElement?.parentElement?.innerText || '').replace(/\s+/g, ' ').trim();
        out[l] = t.startsWith(l) ? t.slice(l.length).trim() : null;
      }
      return out;
    }, labels);
    const truncatedHeaders = () => page.evaluate(() => [...document.querySelectorAll('th')].filter((th) => {
      const els = [th, ...th.querySelectorAll('*')];
      return els.some((e) => getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1);
    }).map((th) => th.innerText.trim().replace(/\s+/g, ' ')));
    /** Polls until the table has exactly n rows (debounced search reloads need a moment). */
    const waitForRows = async (n, ms = 6000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await rowCount() === n) return true; await page.waitForTimeout(250); }
      return (await rowCount()) === n;
    };

    const record = (pageKey, name, ok, detail = '', spec = null) => {
      checks.push({ page: pageKey, name, status: ok ? 'pass' : 'fail', detail });
      if (!ok && spec) findings.push(createFinding({
        runner: RUNNER, category: CATEGORY.CUSTOM_APP, severity: SEVERITY.MEDIUM, evidence: detail, ...spec
      }));
      return ok;
    };
    const skip = (pageKey, name, detail) => checks.push({ page: pageKey, name, status: 'skip', detail });
    const section = async (pageKey, name, fn) => {
      try { await fn(); } catch (err) {
        checks.push({ page: pageKey, name, status: 'error', detail: `Check could not complete: ${err.message.split('\n')[0].slice(0, 160)}` });
        logger.warn(`[integrity] ${pageKey} / ${name}: ${err.message.split('\n')[0]}`);
      }
    };
    const stopIfWrites = () => blocked.length > 0;

    const WIDTHS = [390, 768, 1024, 1280, 1440, 1920];

    /** Opens the date calendar on `path` at each screen width and checks it stays inside the window. */
    const calendarFitsAtWidths = async (pageKey, label, path, triggerRe) => {
      const result = {};
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 900 });
        await goto(path);
        try {
          await page.getByRole('button', { name: triggerRe }).first().click({ timeout: 8000 });
          await page.waitForTimeout(500);
          result[w] = await page.locator(POPOVER).last().evaluate((p) => { const r = p.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth }; });
        } catch { result[w] = null; }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      (metrics.calendarFit ??= {})[pageKey] = result;
      const bad = WIDTHS.filter((w) => result[w] && (result[w].left < 0 || result[w].right > result[w].vw));
      const missing = WIDTHS.filter((w) => !result[w]);
      const summary = WIDTHS.map((w) => (result[w] ? `${w}px: ${result[w].left < 0 || result[w].right > result[w].vw ? `outside window (${result[w].left}→${result[w].right})` : 'ok'}` : `${w}px: did not open`)).join(' | ');
      record(pageKey, `${label} calendar stays inside the window at ${WIDTHS.join(', ')}px`, bad.length === 0 && missing.length === 0, summary, {
        id: `integrity-${pageKey}-calendar-clipped`, severity: SEVERITY.MEDIUM,
        title: `The ${label} date calendar is cut off on some screen sizes (${[...bad, ...missing].join(', ')}px)`,
        detail: `The date calendar on ${label} runs past the edge of the browser window at ${[...bad, ...missing].join(' / ')}px wide, so part of the calendar cannot be seen or clicked.`,
        recommendation: 'Anchor the calendar to the right edge of its button, or flip/shift it when it would overflow the window.'
      });
    };

    /**
     * Single calendar used by Stores, Store Detail and Email Logs: opens, month navigation, future months
     * blocked, Escape, then a start-day + end-day range (same view) whose rows are verified by cfg.verifyRows.
     */
    const exerciseCalendar = async (pageKey, triggerRe, cfg) => {
      const trigger = await page.getByRole('button', { name: triggerRe }).first().elementHandle();
      await trigger.click(); await page.waitForTimeout(500);
      const pop = page.locator(POPOVER).last();
      const opened = (await page.locator(POPOVER).count()) > 0;
      record(pageKey, `${cfg.label} calendar opens`, opened, '');
      if (!opened) return;
      const label = async () => norm(await pop.locator('button').nth(1).innerText());
      const month0 = await label();
      await pop.locator('button').first().click(); await page.waitForTimeout(300);
      const month1 = await label();
      await pop.locator('button').nth(2).click(); await page.waitForTimeout(300);
      record(pageKey, `${cfg.label} calendar month navigation works`, month1 !== month0 && (await label()) === month0, `${month0} → ${month1} → ${await label()}`);
      record(pageKey, `${cfg.label} calendar blocks future months`, await pop.locator('button').nth(2).isDisabled(), '');
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      const escCloses = (await page.locator(POPOVER).count()) === 0;
      record(pageKey, `${cfg.label} calendar closes with Escape`, escCloses, escCloses ? '' : 'Still open after pressing Escape', {
        id: `integrity-${pageKey}-datepicker-escape`, severity: SEVERITY.LOW,
        title: `The date filter on ${cfg.label} cannot be closed with the keyboard`,
        detail: 'After opening the date calendar, pressing Escape leaves it open. Clicking outside it does close it, so only keyboard users are affected: they have no way to dismiss the calendar.',
        recommendation: 'Close the calendar on the Escape key as well as on an outside click.'
      });
      if (!escCloses) {
        await page.mouse.click(700, 60); await page.waitForTimeout(400);
        const outsideCloses = (await page.locator(POPOVER).count()) === 0;
        record(pageKey, `${cfg.label} calendar closes when clicking outside it`, outsideCloses, outsideCloses ? 'Closed by an outside click' : 'Still open after an outside click', {
          id: `integrity-${pageKey}-datepicker-outside`, severity: SEVERITY.MEDIUM, title: `The date filter on ${cfg.label} cannot be closed at all without choosing a date`,
          detail: 'Neither Escape nor clicking outside the calendar closes it.', recommendation: 'Close the calendar on an outside click and on Escape.'
        });
      }
      // Range: click a start day then an end day (same calendar)
      const range = cfg.getRange();
      const calls = [];
      const onReq = (r) => { if (r.url().includes(cfg.apiPath)) calls.push(r.url()); };
      page.on('request', onReq);
      if (!(await page.locator(POPOVER).count())) { await trigger.click(); await page.waitForTimeout(400); }
      await page.locator(POPOVER).last().getByText(String(range.startDay), { exact: true }).first().click(); await page.waitForTimeout(500);
      if (!(await page.locator(POPOVER).count())) { await trigger.click(); await page.waitForTimeout(400); }
      await page.locator(POPOVER).last().getByText(String(range.endDay), { exact: true }).first().click(); await settle();
      page.off('request', onReq);
      const lastCall = calls[calls.length - 1] ?? '';
      const hasBoth = lastCall.includes(`${cfg.startParam}=`) && lastCall.includes(`${cfg.endParam}=`);
      record(pageKey, `${cfg.label} date range applies both a start and an end date`, hasBoth, `Button reads "${norm(await trigger.innerText())}"; request: ${lastCall.replace(/^.*\/api/, '/api')}`, {
        id: `integrity-${pageKey}-date-range`, severity: SEVERITY.MEDIUM, title: `${cfg.label} date range does not apply both dates`,
        detail: 'After choosing a start and an end day, the list was requested without both dates, so the range is not being applied.', recommendation: 'Send both the start and end date with the request.'
      });
      const v = await cfg.verifyRows(await rows(), range);
      record(pageKey, `${cfg.label} date range lists only matching rows`, v.ok, v.detail, {
        id: `integrity-${pageKey}-date-filter`, severity: SEVERITY.MEDIUM, title: `${cfg.label} date range shows the wrong rows`,
        detail: 'After choosing a start and end day, the list did not match that range.', recommendation: 'Check the date-range filter query and its time zone handling.'
      });
    };

    // ── login ─────────────────────────────────────────────────────────────
    await goto(config.pages.dashboard.path);
    if (page.url().includes(config.auth.loginPath)) {
      await page.fill(config.auth.usernameSelector, username);
      await page.fill(config.auth.passwordSelector, password);
      await Promise.all([
        page.waitForURL((u) => !u.pathname.startsWith(config.auth.loginPath), { timeout: 30000 }).catch(() => null),
        page.click(config.auth.submitSelector)
      ]);
      await settle();
    }
    const loggedIn = !page.url().includes(config.auth.loginPath);
    record('login', 'Login with the configured account reaches the dashboard', loggedIn, loggedIn ? '' : 'Still on the login page', {
      id: 'integrity-login-failed', severity: SEVERITY.HIGH, title: 'Could not sign in to the custom app dashboard',
      detail: 'The configured admin login did not get past the sign-in page, so no dashboard checks could run.',
      recommendation: 'Confirm the dashboard account still exists and the credentials in .env are current.'
    });
    if (!loggedIn) { await browser.close(); return createRunnerResult(RUNNER, config.baseUrl, findings, metrics); }
    await context.storageState({ path: sessionPath });
    armed = true; // from here on every write request is aborted + reported

    // ── navigation shell ──────────────────────────────────────────────────
    for (const [key, p] of Object.entries(config.pages)) {
      await section(key, 'Page loads with the right heading', async () => {
        await goto(p.path);
        const heading = await page.$$eval('h1,h2,h3', (h) => h.map((x) => x.innerText.trim()));
        record(key, `"${p.heading}" page loads`, heading.some((h) => lc(h) === lc(p.heading)), `Headings: ${heading.slice(0, 4).join(' | ')}`, {
          id: `integrity-${key}-page-heading`, severity: SEVERITY.HIGH, title: `${p.heading} page did not load correctly`,
          detail: 'The page opened without its expected heading, so it may be blank or showing an error.', recommendation: 'Open the page manually and check for an error state.'
        });
        if (key === 'dashboard') {
          const nav = await page.$$eval('nav a, aside a', (a) => a.map((x) => x.innerText.trim()));
          record('dashboard', 'Sidebar shows all 4 sections', config.expect.nav.every((n) => nav.includes(n)), nav.join(' | '));
        }
      });
    }

    // ── stores: snapshot first (dashboard totals are cross-checked against it) ──
    let snapshot = null;
    await section('stores', 'Stores snapshot', async () => {
      await goto(config.pages.stores.path);
      await setPageSize(100);
      const h = await headers();
      record('stores', 'Table has the expected 11 columns', JSON.stringify(h) === JSON.stringify(config.expect.storeColumns), h.join(' | '), {
        id: 'integrity-stores-columns', severity: SEVERITY.LOW, title: 'Stores Listing columns changed',
        detail: 'The columns in the stores table differ from what was recorded when coverage was set up.', recommendation: 'Confirm the change is intended, then update config/integrity-dashboard.json.'
      });
      const all = await rows();
      snapshot = {
        rows: all.map((r) => ({ name: r[1], url: r[2], plan: r[3], trees: num(r[4]), contribution: num(r[5]), limit: r[6], installed: r[7], uninstalled: r[8], status: r[9] })),
      };
      snapshot.total = snapshot.rows.length;
      snapshot.active = snapshot.rows.filter((r) => lc(r.status) === 'active').length;
      snapshot.sumTrees = snapshot.rows.reduce((a, r) => a + r.trees, 0);
      snapshot.sumContribution = snapshot.rows.reduce((a, r) => a + r.contribution, 0);
      record('stores', 'Stores table shows data', snapshot.total > 0, `${snapshot.total} store(s)`, {
        id: 'integrity-stores-empty', severity: SEVERITY.HIGH, title: 'Stores Listing is empty',
        detail: 'No stores are listed, although the app has installed stores.', recommendation: 'Check the stores API and database connection.'
      });
      record('stores', 'Rows are numbered 1..N on a single page', snapshot.total > 0 && all.every((r, i) => num(r[0]) === i + 1), all.map((r) => r[0]).join(','));
      Object.assign(metrics.stores, { total: snapshot.total, active: snapshot.active, sumTrees: snapshot.sumTrees, sumContribution: snapshot.sumContribution });
      const th = await truncatedHeaders();
      if (th.length) record('stores', 'Column headings fully visible', false, `Cut off: ${th.join(', ')}`, {
        id: 'integrity-stores-truncated-headers', severity: SEVERITY.LOW, title: 'Some Stores Listing column headings are cut off',
        detail: 'A few column titles are shortened with "..." so users cannot read what the column is.', recommendation: 'Widen the columns or allow headings to wrap.'
      });
    });

    // ── dashboard ─────────────────────────────────────────────────────────
    await section('dashboard', 'Dashboard checks', async () => {
      await goto(config.pages.dashboard.path);
      await page.waitForSelector('select', { timeout: 10000 }).catch(() => null);
      const k = await kpis(config.expect.kpis);
      const missing = config.expect.kpis.filter((l) => !k[l]);
      record('dashboard', 'All 6 summary cards show a value', missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : JSON.stringify(k), {
        id: 'integrity-dashboard-kpis-missing', severity: SEVERITY.HIGH, title: 'Dashboard summary cards are missing values',
        detail: `These cards did not show a value: ${missing.join(', ')}.`, recommendation: 'Check the dashboard summary API.'
      });
      metrics.dashboard.kpis = k;
      const charts = await page.evaluate(() => [...document.querySelectorAll('svg')].filter((s) => s.getBoundingClientRect().width > 300 && s.getBoundingClientRect().height > 120).length);
      record('dashboard', 'Both 30-day charts render', charts >= 2, `${charts} chart(s) drawn`, {
        id: 'integrity-dashboard-charts', severity: SEVERITY.MEDIUM, title: 'Dashboard charts did not render',
        detail: 'One or both of the "last 30 days" charts are blank.', recommendation: 'Check the chart data requests for errors.'
      });
      if (snapshot) {
        record('dashboard', 'Total Stores matches Stores Listing', num(k['Total Stores']) === snapshot.total, `Dashboard ${k['Total Stores']} vs list ${snapshot.total}`, {
          id: 'integrity-dashboard-total-stores', severity: SEVERITY.MEDIUM, title: 'Dashboard store count does not match Stores Listing',
          detail: 'The "Total Stores" number differs from the number of stores in the listing.', recommendation: 'Make both read from the same source.'
        });
        record('dashboard', 'Active Stores matches Stores Listing', num(k['Active Stores']) === snapshot.active, `Dashboard ${k['Active Stores']} vs list ${snapshot.active}`, {
          id: 'integrity-dashboard-active-stores', severity: SEVERITY.MEDIUM, title: 'Dashboard active-store count does not match Stores Listing',
          detail: 'The "Active Stores" number differs from the stores marked Active in the listing.', recommendation: 'Make both use the same definition of Active.'
        });
        record('dashboard', 'Total Trees Funded equals the sum of store trees', num(k['Total Trees Funded']) === snapshot.sumTrees, `Dashboard ${k['Total Trees Funded']} vs stores ${snapshot.sumTrees}`, {
          id: 'integrity-dashboard-trees-sum', severity: SEVERITY.HIGH, title: 'Dashboard tree total does not add up',
          detail: 'The total trees funded on the dashboard differs from the sum of the per-store tree counts.', recommendation: 'Check how the dashboard total is calculated.'
        });
        record('dashboard', 'Total Contributions equals the sum of store contributions', Math.abs(num(k['Total Contributions']) - snapshot.sumContribution) < 0.01, `Dashboard ${k['Total Contributions']} vs stores ${snapshot.sumContribution}`, {
          id: 'integrity-dashboard-contrib-sum', severity: SEVERITY.HIGH, title: 'Dashboard contribution total does not add up',
          detail: 'The total contribution amount differs from the sum of the per-store contributions.', recommendation: 'Check how the dashboard total is calculated.'
        });
      }
      record('dashboard', 'Customer + Merchant contributions equal the total', Math.abs(num(k['Customer Contributions']) + num(k['Merchant Contributions']) - num(k['Total Contributions'])) < 0.01, `${k['Customer Contributions']} + ${k['Merchant Contributions']} vs ${k['Total Contributions']}`, {
        id: 'integrity-dashboard-contrib-split', severity: SEVERITY.HIGH, title: 'Customer and merchant contributions do not add up to the total',
        detail: 'The two contribution types do not sum to the total shown.', recommendation: 'Check how the split is calculated.'
      });
      // Top 5 contributors
      const top = (await page.$$eval('table', (ts) => [...(ts[0]?.querySelectorAll('tbody tr') ?? [])].map((tr) => [...tr.children].map((c) => c.innerText.trim().replace(/\s+/g, ' ')))));
      const amounts = top.map((r) => num(r[5]));
      record('dashboard', 'Top 5 Contributors: at most 5 rows, ranked high to low', top.length > 0 && top.length <= 5 && amounts.every((a, i) => i === 0 || amounts[i - 1] >= a) && top.every((r, i) => num(r[0]) === i + 1), `${top.length} rows; amounts ${amounts.join(', ')}`, {
        id: 'integrity-dashboard-top5-order', severity: SEVERITY.MEDIUM, title: 'Top 5 Contributors is not ranked correctly',
        detail: 'The Top 5 table has the wrong number of rows or is not sorted from highest to lowest contribution.', recommendation: 'Sort the ranking by contribution amount, descending.'
      });
      // Recent contributions: pagination + page size + Refresh
      const info = await pageInfo();
      record('dashboard', 'Recent Contributions shows data and page count', !!info && info.pages >= 1, JSON.stringify(info));
      if (info && info.pages > 1) {
        const first = (await page.$$eval('table', (ts) => [...(ts[1]?.querySelectorAll('tbody tr') ?? [])].map((tr) => tr.children[1]?.innerText.trim())));
        await page.getByRole('button', { name: 'Next', exact: true }).click(); await settle();
        const p2 = await pageInfo();
        const second = (await page.$$eval('table', (ts) => [...(ts[1]?.querySelectorAll('tbody tr') ?? [])].map((tr) => tr.children[1]?.innerText.trim())));
        record('dashboard', 'Recent Contributions: Next moves to page 2 with different rows', p2?.page === 2 && JSON.stringify(first) !== JSON.stringify(second), `page ${p2?.page}`, {
          id: 'integrity-dashboard-recent-next', severity: SEVERITY.MEDIUM, title: 'Recent Contributions pagination does not work',
          detail: 'Clicking Next on Recent Contributions did not show a different page of results.', recommendation: 'Check the pagination on the contributions table.'
        });
        await page.getByRole('button', { name: 'Previous', exact: true }).click(); await settle();
        record('dashboard', 'Recent Contributions: Previous returns to page 1', (await pageInfo())?.page === 1, '');
      }
      await setPageSize(5);
      const small = (await page.$$eval('table', (ts) => ts[1]?.querySelectorAll('tbody tr').length ?? 0));
      record('dashboard', 'Recent Contributions: page size 5 shows at most 5 rows', small > 0 && small <= 5, `${small} rows`);
      await setPageSize(10);
      const beforeBlocked = blocked.length;
      await page.getByRole('button', { name: 'Refresh' }).click(); await settle();
      record('dashboard', 'Refresh button reloads without errors', blocked.length === beforeBlocked, 'Refresh issued only read requests');
      const th = await truncatedHeaders();
      if (th.length) record('dashboard', 'Table headings fully visible', false, `Cut off: ${th.join(', ')}`, {
        id: 'integrity-dashboard-truncated-headers', severity: SEVERITY.LOW, title: 'Some Dashboard table headings are cut off',
        detail: 'Column titles such as "Contribution", "Transaction ID" and "Status" are shortened with "..." so users cannot read them.', recommendation: 'Widen the columns or let headings wrap.'
      });
    });

    // ── stores: search / filters / pagination / date range ────────────────
    await section('stores', 'Stores filters', async () => {
      if (!snapshot || stopIfWrites()) return;
      await goto(config.pages.stores.path);
      const total = snapshot.total;
      const search = page.locator('input[placeholder*="Search"]').first();
      const needle = snapshot.rows[0].name.slice(0, 5).toLowerCase();
      await search.fill(needle); await settle();
      const found = (await rows()).map((r) => lc(r[1]));
      record('stores', 'Search finds a store by name', found.length > 0 && found.every((n) => n.includes(needle)), `"${needle}" → ${found.length} row(s)`, {
        id: 'integrity-stores-search', severity: SEVERITY.MEDIUM, title: 'Store search returns the wrong stores',
        detail: 'Searching for part of a store name returned no rows or stores that do not match.', recommendation: 'Check the store-name search.'
      });
      await search.fill('zzzz-no-such-store'); await settle();
      record('stores', 'Search with no match shows an empty-state message', await bodyHas(config.expect.emptyStates.stores), config.expect.emptyStates.stores);
      await search.fill(''); await settle();
      record('stores', 'Clearing search restores the list', await waitForRows(Math.min(total, 10)), `${await rowCount()} row(s)`);

      // Status filter
      const statusOpts = (await selectOptions(0)).slice(1);
      const statusCounts = {}; const mismatches = [];
      for (const opt of statusOpts) {
        await page.locator('select').nth(0).selectOption({ label: opt }); await settle();
        const r = await rows(); statusCounts[opt] = r.length;
        r.forEach((x) => { if (lc(x[9]) !== lc(opt)) mismatches.push(`${opt}→"${x[9]}"`); });
      }
      await page.locator('select').nth(0).selectOption({ label: 'All Status' }); await settle();
      const displayedStatuses = [...new Set(snapshot.rows.map((r) => r.status))];
      const notOffered = displayedStatuses.filter((s) => !statusOpts.map(lc).includes(lc(s)));
      record('stores', 'Status filter shows only matching stores', mismatches.length === 0, mismatches.length ? `Mismatch: ${[...new Set(mismatches)].join('; ')}` : JSON.stringify(statusCounts), {
        id: 'integrity-stores-status-filter-label', severity: SEVERITY.MEDIUM, title: 'Stores status filter and status column use different wording',
        detail: `Choosing a status filter returns stores whose status column reads differently (${[...new Set(mismatches)].join('; ')}). Users cannot tell whether the filter or the label is right.`,
        recommendation: 'Use one set of status names in both the filter and the table.'
      });
      record('stores', 'Every status shown in the table can be filtered', notOffered.length === 0, notOffered.length ? `Not offered in filter: ${notOffered.join(', ')}` : '', {
        id: 'integrity-stores-status-not-filterable', severity: SEVERITY.MEDIUM, title: 'Some store statuses cannot be filtered',
        detail: `Stores with status "${notOffered.join(', ')}" appear in the table but no filter option matches that wording.`, recommendation: 'Align the filter options with the statuses in the table.'
      });
      record('stores', 'Status filter counts add up to all stores', Object.values(statusCounts).reduce((a, b) => a + b, 0) === total, `${JSON.stringify(statusCounts)} vs ${total}`);

      // Plan filter
      const planOpts = (await selectOptions(1)).slice(1);
      const planCounts = {}; const planMismatch = [];
      for (const opt of planOpts) {
        await page.locator('select').nth(1).selectOption({ label: opt }); await settle();
        const r = await rows(); planCounts[opt] = r.length;
        r.forEach((x) => { if (lc(x[3]) !== lc(opt)) planMismatch.push(`${opt}→"${x[3]}"`); });
      }
      await page.locator('select').nth(1).selectOption({ label: 'All Plans' }); await settle();
      const displayedPlans = [...new Set(snapshot.rows.map((r) => r.plan))];
      const plansMissing = displayedPlans.filter((p) => !planOpts.map(lc).includes(lc(p)));
      const unreachable = snapshot.rows.filter((r) => plansMissing.includes(r.plan)).length;
      record('stores', 'Plan filter shows only matching stores', planMismatch.length === 0, JSON.stringify(planCounts), {
        id: 'integrity-stores-plan-filter-mismatch', severity: SEVERITY.MEDIUM, title: 'Stores plan filter returns the wrong plans',
        detail: `Some plan filters return stores on a different plan (${[...new Set(planMismatch)].join('; ')}).`, recommendation: 'Fix the plan filter query.'
      });
      record('stores', 'Every plan shown in the table can be filtered', plansMissing.length === 0, plansMissing.length ? `Not offered: ${plansMissing.join(', ')} (${unreachable} store(s))` : '', {
        id: 'integrity-stores-plan-filter-missing-option', severity: SEVERITY.MEDIUM, title: `Stores plan filter is missing the "${plansMissing.join('", "')}" plan`,
        detail: `${unreachable} store(s) are on the "${plansMissing.join(', ')}" plan, but the Plan filter only offers ${planOpts.join(', ')}. Those stores can never be found by filtering on their plan.`,
        recommendation: `Add "${plansMissing.join('", "')}" to the Plan filter (or map it to the current Shopify plan name).`
      });
      const planSum = Object.values(planCounts).reduce((x, y) => x + y, 0);
      record('stores', 'Plan filter counts add up to all stores', planSum === total, `${JSON.stringify(planCounts)} vs ${total}`, {
        id: 'integrity-stores-plan-filter-counts', severity: SEVERITY.MEDIUM, title: 'Stores plan filter does not cover every store',
        detail: `Adding up the stores returned by each plan filter gives ${planSum}, but there are ${total} stores, so some stores can never be reached by a plan filter.`, recommendation: 'Make the Plan filter list every plan that appears in the table.'
      });
      Object.assign(metrics.stores, { statusFilterCounts: statusCounts, planFilterCounts: planCounts, plansMissingFromFilter: plansMissing });

      // Pagination
      await setPageSize(5);
      const size5 = await rowCount();
      record('stores', 'Page size 5 shows at most 5 rows', size5 > 0 && size5 <= 5, `${size5} row(s)`);
      const p1 = (await rows()).map((r) => r[1]);
      const nextBtn = page.getByRole('button', { name: 'Next', exact: true });
      if (total > 5 && await nextBtn.isEnabled()) {
        await nextBtn.click(); await settle();
        const r2 = await rows(); const p2 = r2.map((r) => r[1]);
        record('stores', 'Next shows a different set of stores', JSON.stringify(p1) !== JSON.stringify(p2) && p2.length > 0, `${p2.length} on page 2`, {
          id: 'integrity-stores-next', severity: SEVERITY.MEDIUM, title: 'Stores pagination does not work',
          detail: 'Clicking Next on Stores Listing did not show different stores.', recommendation: 'Check the stores pagination.'
        });
        const firstNo = num(r2[0]?.[0]);
        record('stores', 'Row numbers continue on page 2 (6, 7, 8…)', firstNo === 6, `Page 2 starts at ${firstNo}`, {
          id: 'integrity-stores-numbering-restarts', severity: SEVERITY.LOW, title: 'Stores Listing row numbers restart on every page',
          detail: `On page 2 the "NO." column starts again at ${firstNo} instead of continuing from 6, so two different stores can both be "No. 1".`,
          recommendation: 'Number rows continuously across pages: (page − 1) × page size + row.'
        });
        await page.getByRole('button', { name: 'Previous', exact: true }).click(); await settle();
        record('stores', 'Previous returns to the first page', JSON.stringify((await rows()).map((r) => r[1])) === JSON.stringify(p1), '');
      } else skip('stores', 'Pagination Next/Previous', 'Not enough stores for a second page at size 5');
      await setPageSize(10);

      // Date range
      const nowD = new Date();
      await exerciseCalendar('stores', /Select date/, {
        label: 'Stores', apiPath: '/api/stores', startParam: 'fromDate', endParam: 'toDate',
        getRange: () => { const endDay = Math.min(nowD.getDate(), 28); return { startDay: 1, endDay, from: new Date(nowD.getFullYear(), nowD.getMonth(), 1), toExclusive: new Date(nowD.getFullYear(), nowD.getMonth(), endDay + 1) }; },
        verifyRows: async (rws, range) => {
          const expected = snapshot.rows.filter((r) => { const t = Date.parse(r.installed); return t >= range.from.getTime() && t < range.toExclusive.getTime(); }).map((r) => r.name).sort();
          const got = rws.filter((x) => x[1]).map((x) => x[1]).sort();
          return { ok: JSON.stringify(got) === JSON.stringify(expected), detail: `${got.length} store(s) shown; ${expected.length} installed between ${range.from.toDateString()} and ${new Date(range.toExclusive.getTime() - 86400000).toDateString()}` };
        }
      });
      await calendarFitsAtWidths('stores', 'Stores', config.pages.stores.path, /Select date/);
    });

    // ── responsive layout: View button reachability + no sideways page scroll, at phone → desktop widths ──
    await section('stores', 'Responsive layout', async () => {
      if (stopIfWrites()) return;
      const result = {}; const overflow = {};
      const pageOverflow = () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 900 });
        await goto(config.pages.stores.path);
        result[w] = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('table tbody tr button, [class*=card] button')].find((x) => /view/i.test(x.innerText));
          if (!btn) return { found: false };
          const br = btn.getBoundingClientRect();
          let hidden = false; let scroll = false; let container = false;
          for (let el = btn.parentElement; el && el !== document.body; el = el.parentElement) {
            const st = getComputedStyle(el);
            if (st.overflowX !== 'visible') {
              container = true;
              const r = el.getBoundingClientRect();
              if (br.right > r.right + 1 || br.left < r.left - 1) { if (st.overflowX === 'auto' || st.overflowX === 'scroll') scroll = true; else hidden = true; }
              break;
            }
          }
          if (!container && (br.right > innerWidth + 1 || br.left < -1)) hidden = true;
          const cut = [...document.querySelectorAll('th')].filter((th) => [th, ...th.querySelectorAll('*')].some((e) => getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1)).length;
          return { found: true, hidden, scroll, cutHeadings: cut, btnRight: Math.round(br.right), vw: innerWidth };
        });
        overflow[w] = { stores: await pageOverflow() };
        for (const key of ['dashboard', 'emails', 'emailLogs']) { await goto(config.pages[key].path); overflow[w][key] = await pageOverflow(); }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      metrics.stores.layout = result; metrics.layoutOverflow = overflow;
      // Sideways scrolling INSIDE a table is normal on phones/tablets; below 1024px only a clipped (unreachable) button fails.
      const bad = WIDTHS.filter((w) => result[w].found && (result[w].hidden || (result[w].scroll && w >= 1024)));
      const state = (w) => (!result[w].found ? 'no View button' : result[w].hidden ? 'cut off' : result[w].scroll ? 'needs sideways scroll' : 'ok');
      record('stores', `The View button is reachable at ${WIDTHS.join(', ')}px`, bad.length === 0, WIDTHS.map((w) => `${w}px: ${state(w)}, ${result[w].cutHeadings ?? '?'} cut heading(s)`).join(' | '), {
        id: 'integrity-stores-view-button-clipped', severity: SEVERITY.MEDIUM,
        title: `The "View" button on Stores Listing is cut off on some screen widths (${bad.join(', ')}px)`,
        detail: `On a ${bad.join(' / ')}px-wide screen the Actions column runs off the right side of the table, so the "View" button is clipped or needs sideways scrolling. This is the only way to open a store's details.`,
        recommendation: 'Let the table fit its container: reduce column padding, allow headings and the Spending Limit to wrap, or give the Actions column a fixed minimum width.'
      });
      const sideways = WIDTHS.flatMap((w) => Object.entries(overflow[w]).filter(([, d]) => d > 1).map(([k, d]) => `${k} @${w}px (+${d}px)`));
      record('stores', 'No dashboard page scrolls sideways at any screen width', sideways.length === 0, sideways.length ? sideways.join(', ') : `Checked ${WIDTHS.length} widths × 4 pages`, {
        id: 'integrity-layout-page-overflow', severity: SEVERITY.MEDIUM, title: 'Some dashboard pages scroll sideways on smaller screens',
        detail: `The whole page becomes wider than the window at: ${sideways.join(', ')}. Users have to scroll sideways to see all of the page.`,
        recommendation: 'Constrain page content to the window width and let only tables scroll inside their own container.'
      });
    });

    // ── stores: View → store detail (every store) ─────────────────────────
    await section('stores', 'Store detail pages', async () => {
      if (!snapshot || stopIfWrites()) return;
      const limit = Math.min(snapshot.total, config.thresholds.maxStoreDetailPages);
      const problems = { sections: [], name: [], plan: [], trees: [], contribution: [], uninstall: [], eventCounts: [], duplicates: [], toggles: [] };
      let visited = 0;
      for (let i = 0; i < limit && !stopIfWrites(); i++) {
        await goto(config.pages.stores.path); await setPageSize(100);
        const row = snapshot.rows[i];
        await page.locator('table tbody tr').nth(i).getByRole('button', { name: 'View', exact: true }).click();
        await page.waitForURL(/\/dashboard\/stores\/\d+/, { timeout: 15000 }).catch(() => null);
        await settle();
        if (!/\/dashboard\/stores\/\d+/.test(page.url())) { problems.sections.push(`${row.name} (View did not open the detail page)`); continue; }
        visited++;
        const body = await page.evaluate(() => document.body.innerText);
        const missingSections = config.expect.storeDetailSections.filter((s) => !body.includes(s));
        if (missingSections.length) problems.sections.push(`${row.name}: ${missingSections.join(', ')}`);
        const field = (label) => page.evaluate((l) => {
          const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.innerText?.trim() === l);
          return (el?.parentElement?.innerText || '').replace(l, '').replace(/\s+/g, ' ').trim();
        }, label);
        const f = { name: await field('Store Name'), plan: await field('Shopify Plan'), uninstall: await field('Uninstall Date') };
        const k = await kpis(['Total Contributions', 'Total Trees Funded']);
        if (lc(f.name) !== lc(row.name)) problems.name.push(`${row.name} ≠ "${f.name}"`);
        if (lc(f.plan) !== lc(row.plan)) problems.plan.push(`${row.name}: list "${row.plan}" vs detail "${f.plan}"`);
        if (num(k['Total Trees Funded']) !== row.trees) problems.trees.push(`${row.name}: list ${row.trees} vs detail ${k['Total Trees Funded']}`);
        if (Math.abs(num(k['Total Contributions']) - row.contribution) > 0.01) problems.contribution.push(`${row.name}: list ${row.contribution} vs detail ${k['Total Contributions']}`);
        const listUn = /^[—-]$/.test(row.uninstalled) ? '' : row.uninstalled; const detUn = /^[—-]$/.test(f.uninstall) ? '' : f.uninstall;
        if (listUn !== detUn) problems.uninstall.push(`${row.name}: list "${row.uninstalled}" vs detail "${f.uninstall}"`);
        // Install history: collect events across pages
        const events = [];
        for (let pg = 0; pg < 10; pg++) {
          events.push(...(await page.$$eval('table', (ts) => [...(ts[0]?.querySelectorAll('tbody tr') ?? [])].map((tr) => [...tr.children].map((c) => c.innerText.trim().replace(/\s+/g, ' '))))));
          const nxt = page.getByRole('button', { name: 'Next', exact: true }).first();
          if (!(await nxt.isEnabled().catch(() => false))) break;
          await nxt.click(); await settle();
        }
        const inst = num((body.match(/Total installs:\s*(\d+)/) || [])[1]); const uninst = num((body.match(/Total uninstalls:\s*(\d+)/) || [])[1]);
        const installed = events.filter((e) => /installed/i.test(e[1]) && !/un/i.test(e[1])).length; const uninstalled = events.filter((e) => /uninstalled/i.test(e[1])).length;
        if (events.length && (inst !== installed || uninst !== uninstalled)) problems.eventCounts.push(`${row.name}: header ${inst}/${uninst} vs rows ${installed}/${uninstalled}`);
        for (let e = 1; e < events.length; e++) if (events[e][1] === events[e - 1][1] && events[e][2] === events[e - 1][2] && events[e][3] === events[e - 1][3]) problems.duplicates.push(`${row.name}: ${events[e][1]} on ${events[e][2]} ${events[e][3]}`);
        // Financial breakdown toggles (view only)
        for (const t of ['Weekly', 'Monthly', 'Daily']) {
          try { await page.getByRole('button', { name: t }).first().click({ timeout: 6000 }); await settle(); } catch { problems.toggles.push(`${row.name}: ${t}`); }
        }
      }
      const best = snapshot.rows.map((r, i) => ({ r, i })).sort((x, y) => y.r.trees - x.r.trees)[0];
      if (best && best.r.trees > 0 && !stopIfWrites()) {
        await goto(config.pages.stores.path); await setPageSize(100);
        await page.locator('table tbody tr').nth(best.i).getByRole('button', { name: 'View', exact: true }).click();
        await page.waitForURL(/\/dashboard\/stores\/\d+/, { timeout: 15000 }).catch(() => null); await settle();
        const detailPath = new URL(page.url()).pathname;
        const nowD = new Date();
        await exerciseCalendar('storeDetail', /Select date/, {
          label: 'Store Detail', apiPath: '/transactions', startParam: 'startDate', endParam: 'endDate',
          getRange: () => { const endDay = Math.min(nowD.getDate(), 28); return { startDay: 1, endDay, from: new Date(nowD.getFullYear(), nowD.getMonth(), 1), toExclusive: new Date(nowD.getFullYear(), nowD.getMonth(), endDay + 1) }; },
          verifyRows: async (_rws, range) => {
            const t = await page.$$eval('table', (ts) => [...(ts[ts.length - 1]?.querySelectorAll('tbody tr') ?? [])].map((tr) => [...tr.children].map((c) => c.innerText.trim().replace(/\s+/g, ' '))));
            const times = t.map((x) => Date.parse(x[3]));
            return { ok: t.length > 0 && times.every((d) => d >= range.from.getTime() && d < range.toExclusive.getTime()), detail: `${t.length} contribution row(s) for ${best.r.name} between ${range.from.toDateString()} and ${new Date(range.toExclusive.getTime() - 86400000).toDateString()}` };
          }
        });
        await calendarFitsAtWidths('storeDetail', 'Store Detail', detailPath, /Select date/);
      }
      metrics.stores.detailPagesChecked = visited;
      const rec = (key, name, list, spec) => record('storeDetail', name, list.length === 0, list.length ? list.join(' | ') : `${visited} store(s) checked`, list.length ? spec : null);
      rec('sections', 'Store detail shows all 5 sections', problems.sections, { id: 'integrity-detail-sections', severity: SEVERITY.HIGH, title: 'Some store detail pages are missing sections', detail: `Missing content: ${problems.sections.join('; ')}.`, recommendation: 'Check the store detail page for errors.' });
      rec('name', 'Store name matches the listing', problems.name, { id: 'integrity-detail-name', severity: SEVERITY.HIGH, title: 'Store detail shows a different store name than the listing', detail: problems.name.join('; '), recommendation: 'Check which store the View link opens.' });
      rec('plan', 'Plan matches the listing', problems.plan, { id: 'integrity-detail-plan', severity: SEVERITY.MEDIUM, title: 'Store plan differs between the listing and the store page', detail: problems.plan.join('; '), recommendation: 'Show the same plan name in both places.' });
      rec('trees', 'Trees funded matches the listing', problems.trees, { id: 'integrity-detail-trees', severity: SEVERITY.HIGH, title: 'Tree totals differ between the listing and a store page', detail: problems.trees.join('; '), recommendation: 'Make both read from the same source.' });
      rec('contribution', 'Contributions match the listing', problems.contribution, { id: 'integrity-detail-contribution', severity: SEVERITY.HIGH, title: 'Contribution totals differ between the listing and a store page', detail: problems.contribution.join('; '), recommendation: 'Make both read from the same source.' });
      rec('uninstall', 'Uninstall date matches the listing', problems.uninstall, { id: 'integrity-detail-uninstall', severity: SEVERITY.MEDIUM, title: 'Uninstall date differs between the listing and a store page', detail: problems.uninstall.join('; '), recommendation: 'Make both read from the same source.' });
      rec('eventCounts', 'Install History totals match its rows', problems.eventCounts, { id: 'integrity-detail-install-counts', severity: SEVERITY.MEDIUM, title: 'Install History totals do not match the events listed', detail: problems.eventCounts.join('; '), recommendation: 'Count events from the same list that is displayed.' });
      rec('duplicates', 'Install History has no duplicated events', problems.duplicates, { id: 'integrity-detail-duplicate-events', severity: SEVERITY.LOW, title: 'Install History lists the same event twice', detail: `The same install/uninstall event is recorded twice within the same minute: ${problems.duplicates.join('; ')}. This usually means the app received the same Shopify notification twice, and it inflates the uninstall count.`, recommendation: 'Ignore a repeated install/uninstall notification for the same store and timestamp.' });
      rec('toggles', 'Financial Breakdown Daily/Weekly/Monthly toggles respond', problems.toggles, { id: 'integrity-detail-toggles', severity: SEVERITY.MEDIUM, title: 'Financial Breakdown period buttons do not respond', detail: problems.toggles.join('; '), recommendation: 'Check the Daily/Weekly/Monthly buttons.' });
    });

    // ── email templates (read-only) ───────────────────────────────────────
    await section('emails', 'Email templates', async () => {
      if (stopIfWrites()) return;
      await goto(config.pages.emails.path);
      const h = await headers();
      record('emails', 'Table has the expected 5 columns', JSON.stringify(h) === JSON.stringify(config.expect.templateColumns), h.join(' | '));
      const r = await rows();
      const codes = r.map((x) => x[2]);
      record('emails', 'Template list shows data', r.length > 0 && r.every((x) => x[1]), `${r.length} template(s) on page 1`, {
        id: 'integrity-emails-empty', severity: SEVERITY.HIGH, title: 'Email Templates list is empty or has blank titles',
        detail: 'No templates, or templates without a title, are shown.', recommendation: 'Check the email templates API.'
      });
      record('emails', 'Template codes are unique', new Set(codes).size === codes.length, codes.join(', '));
      const missing = config.expect.templateCodes.filter((c) => !codes.includes(c));
      record('emails', 'All expected templates are present', missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : `${config.expect.templateCodes.length} expected codes found`, {
        id: 'integrity-emails-template-missing', severity: SEVERITY.HIGH, title: 'An expected e-mail template is missing',
        detail: `These customer e-mail templates were not found: ${missing.join(', ')}. The matching e-mails cannot be sent.`, recommendation: 'Restore the missing template(s).'
      });
      const badStatus = r.filter((x) => !config.expect.templateStatuses.map(lc).includes(lc(x[3]))).map((x) => `${x[2]}:"${x[3]}"`);
      record('emails', 'Each template status is Enabled or Disabled', badStatus.length === 0, badStatus.join(', '));
      const disabled = r.filter((x) => lc(x[3]) === 'disabled').map((x) => x[2]);
      metrics.emails = { templatesOnPage1: r.length, disabled };
      if (disabled.length) record('emails', 'No templates are disabled', false, `Disabled: ${disabled.join(', ')}`, { id: 'integrity-emails-disabled', severity: SEVERITY.LOW, title: 'Some e-mail templates are switched off', detail: `Disabled templates: ${disabled.join(', ')}.`, recommendation: 'Confirm these are meant to be off.' });
      const kw = page.locator('input[placeholder*="Search"]').first();
      const word = (r[0][1].split(' ').find((w) => w.length >= 4) || r[0][1]).toLowerCase();
      await kw.fill(word); await settle();
      const hits = (await rows()).map((x) => lc(x.join(' ')));
      record('emails', 'Keyword search finds matching templates', hits.length > 0 && hits.every((t) => t.includes(word)), `"${word}" → ${hits.length}`, {
        id: 'integrity-emails-search', severity: SEVERITY.MEDIUM, title: 'E-mail template search returns the wrong templates', detail: 'Searching for a word from a template title did not return matching templates.', recommendation: 'Check the template search.'
      });
      await kw.fill('zzzz-no-such'); await settle();
      record('emails', 'Search with no match shows an empty-state message', await bodyHas(config.expect.emptyStates.templates), config.expect.emptyStates.templates);
      await kw.fill(''); await settle();
      record('emails', 'Clearing search restores the list', await waitForRows(r.length), `${await rowCount()} row(s), expected ${r.length}`);
      const prev = page.getByRole('button', { name: 'Previous', exact: true });
      record('emails', 'Previous is disabled on the first page', !(await prev.isEnabled()), '');
      skip('emails', 'Add / Edit / Delete / Send test mail', 'Intentionally not exercised — read-only coverage');
    });

    // ── email logs ────────────────────────────────────────────────────────
    await section('emailLogs', 'Email logs', async () => {
      if (stopIfWrites()) return;
      await goto(config.pages.emailLogs.path);
      const h = await headers();
      record('emailLogs', 'Table has the expected 7 columns', JSON.stringify(h) === JSON.stringify(config.expect.logColumns), h.join(' | '));
      const r = await rows();
      record('emailLogs', 'Log list shows data', r.length > 0, `${r.length} row(s) on page 1`, {
        id: 'integrity-logs-empty', severity: SEVERITY.HIGH, title: 'Email Logs list is empty', detail: 'No e-mail activity is shown.', recommendation: 'Check the email logs API.'
      });
      const badRecipients = r.filter((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x[2])).length;
      record('emailLogs', 'Every recipient is a valid e-mail address', badRecipients === 0, `${badRecipients} invalid`, { id: 'integrity-logs-recipient', severity: SEVERITY.MEDIUM, title: 'Email Logs contain a recipient that is not an e-mail address', detail: `${badRecipients} log row(s) have a malformed recipient.`, recommendation: 'Check what is stored as the recipient.' });
      const badStatus = r.filter((x) => !config.expect.logStatuses.includes(x[4])).map((x) => x[4]);
      record('emailLogs', 'Every status is Sent or Failed', badStatus.length === 0, [...new Set(badStatus)].join(', '));
      const when = r.map((x) => Date.parse(x[5]));
      record('emailLogs', 'Dates are valid and newest first', when.every((t) => Number.isFinite(t)) && when.every((t, i) => i === 0 || when[i - 1] >= t), r.slice(0, 2).map((x) => x[5]).join(' | '), { id: 'integrity-logs-order', severity: SEVERITY.LOW, title: 'Email Logs are not sorted newest first', detail: 'Dates are missing or out of order.', recommendation: 'Sort by sent time, newest first.' });
      const types = [...new Set(r.map((x) => x[1]))];
      const unknownTypes = types.filter((t) => !config.expect.templateCodes.includes(t));
      record('emailLogs', 'Each email type matches a known template', unknownTypes.length === 0, unknownTypes.length ? `Unknown: ${unknownTypes.join(', ')}` : types.join(', '));

      // status filter + failure recency
      const statusSel = page.locator('select').nth(0);
      const filtered = {};
      for (const s of config.expect.logStatuses) {
        await statusSel.selectOption({ label: s }); await settle();
        const rr = await rows(); const info = await pageInfo();
        filtered[s] = { pages: info?.pages ?? null, firstSent: rr[0]?.[5] ?? null };
        record('emailLogs', `Status filter "${s}" shows only ${s} emails`, rr.length > 0 ? rr.every((x) => x[4] === s) : true, `${rr.length} row(s), ${info?.pages ?? '?'} page(s)`, {
          id: `integrity-logs-filter-${s.toLowerCase()}`, severity: SEVERITY.MEDIUM, title: `Email Logs "${s}" filter shows other statuses`, detail: `Filtering on ${s} returned rows with a different status.`, recommendation: 'Fix the status filter query.'
        });
      }
      await statusSel.selectOption({ label: 'All Statuses' }); await settle();
      const lastFail = filtered.Failed?.firstSent ? Date.parse(filtered.Failed.firstSent) : null;
      const days = lastFail ? Math.floor((Date.now() - lastFail) / 86400000) : null;
      metrics.emailLogs = { sentPages: filtered.Sent?.pages, failedPages: filtered.Failed?.pages, latestFailed: filtered.Failed?.firstSent ?? null, daysSinceLatestFailure: days, latestSent: r[0]?.[5] ?? null };
      record('emailLogs', `No e-mail failures in the last ${config.thresholds.failedEmailRecentDays} days`, days === null || days > config.thresholds.failedEmailRecentDays, days === null ? 'No failed e-mails recorded' : `Latest failure ${filtered.Failed.firstSent} (${days} days ago)`, {
        id: 'integrity-logs-recent-failures', severity: SEVERITY.HIGH, title: 'Customer e-mails have failed recently',
        detail: `The latest failed e-mail was sent ${days} day(s) ago (${filtered.Failed?.firstSent}). Customers or merchants may not have received an install, contribution or thank-you e-mail.`, recommendation: 'Open the failed log entries, fix the cause (often e-mail login settings) and re-check.'
      });
      // search
      const search = page.locator('input[placeholder*="Recipient"]').first();
      await search.fill('zzzz-no-such'); await settle();
      record('emailLogs', 'Search with no match shows an empty-state message', await bodyHas(config.expect.emptyStates.logs), config.expect.emptyStates.logs);
      const q = r[0][2].split('@')[0];
      await search.fill(q); await settle();
      const sr = await rows();
      record('emailLogs', 'Search by recipient finds that recipient', sr.length > 0 && sr.every((x) => lc(x.join(' ')).includes(lc(q))), `${sr.length} row(s)`, { id: 'integrity-logs-search', severity: SEVERITY.MEDIUM, title: 'Email Logs search returns the wrong rows', detail: 'Searching for a recipient did not return matching log entries.', recommendation: 'Check the log search.' });
      await search.fill(''); await settle();
      // pagination
      const nxt = page.getByRole('button', { name: 'Next', exact: true });
      if (await nxt.isEnabled()) {
        const first = (await rows()).map((x) => x[5]);
        await nxt.click(); await settle();
        const second = (await rows()).map((x) => x[5]);
        record('emailLogs', 'Next shows a different page of logs', JSON.stringify(first) !== JSON.stringify(second), '', { id: 'integrity-logs-next', severity: SEVERITY.MEDIUM, title: 'Email Logs pagination does not work', detail: 'Clicking Next did not show different log entries.', recommendation: 'Check the logs pagination.' });
        await page.getByRole('button', { name: 'Previous', exact: true }).click(); await settle();
      }
      // date calendar (single date)
      const latest = new Date(r[0][5]); latest.setHours(0, 0, 0, 0);
      await exerciseCalendar('emailLogs', /Select date/, {
        label: 'Email Logs', apiPath: '/api/email-logs', startParam: 'fromDate', endParam: 'toDate',
        getRange: () => { const endDay = latest.getDate(); const startDay = Math.max(1, endDay - 3); const from = new Date(latest); from.setDate(startDay); const toExclusive = new Date(latest); toExclusive.setDate(endDay + 1); return { startDay, endDay, from, toExclusive }; },
        verifyRows: async (rws, range) => { const times = rws.map((x) => Date.parse(x[5])); return { ok: rws.length > 0 && times.every((t) => t >= range.from.getTime() && t < range.toExclusive.getTime()), detail: `${rws.length} row(s) between ${range.from.toDateString()} and ${latest.toDateString()}` }; }
      });
      await calendarFitsAtWidths('emailLogs', 'Email Logs', config.pages.emailLogs.path, /Select date/);
      // row View (only ever the item whose text is exactly "View")
      await goto(config.pages.emailLogs.path);
      await page.locator('table tbody tr').first().locator('button[aria-haspopup="menu"]').click(); await page.waitForTimeout(500);
      const item = page.getByText('View', { exact: true }).last();
      const itemText = norm(await item.innerText().catch(() => ''));
      if (itemText === 'View') {
        const beforeUrl = page.url();
        await item.click(); await settle();
        const overlayText = () => page.evaluate(() => [...document.querySelectorAll('div')].filter((d) => getComputedStyle(d).position === 'fixed' && d.getBoundingClientRect().width > 300 && d.innerText.trim().length > 20).map((d) => d.innerText.replace(/\s+/g, ' '))[0] ?? '');
        const modal = await overlayText();
        const opened = page.url() !== beforeUrl || modal.length > 0;
        record('emailLogs', 'Row "View" opens the e-mail details', opened, opened ? 'Details modal opened' : 'Nothing opened', { id: 'integrity-logs-view', severity: SEVERITY.MEDIUM, title: 'The "View" action on an e-mail log does nothing', detail: 'Choosing View from a log row did not open any details.', recommendation: 'Check the View action on Email Logs.' });
        const wanted = ['Email Log Details', 'Email Type', 'Subject', 'Sent To', 'Store'];
        const missingFields = wanted.filter((w) => !modal.includes(w));
        record('emailLogs', 'E-mail details show type, subject, recipient and store', opened && missingFields.length === 0, missingFields.length ? `Missing: ${missingFields.join(', ')}` : 'All fields present', { id: 'integrity-logs-view-fields', severity: SEVERITY.MEDIUM, title: 'E-mail log details are incomplete', detail: `The details window is missing: ${missingFields.join(', ')}.`, recommendation: 'Show the full e-mail record.' });
        await page.keyboard.press('Escape'); await page.waitForTimeout(500);
        const escClosed = (await overlayText()) === '';
        record('emailLogs', 'E-mail details window closes with Escape', escClosed, escClosed ? '' : 'Still open after Escape', { id: 'integrity-logs-view-escape', severity: SEVERITY.LOW, title: 'The e-mail details window cannot be closed with the keyboard', detail: 'Pressing Escape leaves the e-mail details window open.', recommendation: 'Close the window on Escape.' });
      } else record('emailLogs', 'Row action menu offers "View"', false, `Menu offered: "${itemText}"`);
    });

    // ── cross-page results ────────────────────────────────────────────────
    if (blocked.length) {
      findings.push(createFinding({
        id: 'integrity-dashboard-unexpected-write', runner: RUNNER, category: CATEGORY.CUSTOM_APP, severity: SEVERITY.CRITICAL,
        title: 'The dashboard tried to change data during a read-only check',
        detail: 'A read-only page visit made the app send a request that could change data. The request was blocked before it left the browser and the remaining checks were stopped as a precaution.',
        evidence: blocked.join(' | '), recommendation: 'Review what triggers this request before running further checks.'
      }));
    }
    if (apiErrors.size) findings.push(createFinding({
      id: 'integrity-dashboard-api-errors', runner: RUNNER, category: CATEGORY.CUSTOM_APP, severity: SEVERITY.HIGH,
      title: 'The dashboard received error responses from its own API',
      detail: `While testing, ${apiErrors.size} data request(s) failed, so some data may be missing on screen.`, evidence: [...apiErrors].join(' | '), recommendation: 'Check the dashboard API logs for these requests.'
    }));
    if (consoleErrors.size) findings.push(createFinding({
      id: 'integrity-dashboard-console-errors', runner: RUNNER, category: CATEGORY.CUSTOM_APP, severity: SEVERITY.LOW,
      title: 'The dashboard logged script errors in the browser',
      detail: `${consoleErrors.size} error message(s) appeared in the browser console during testing.`, evidence: [...consoleErrors].slice(0, 6).join(' | '), recommendation: 'Review the front-end errors.'
    }));

    metrics.blockedWrites = blocked;
    await browser.close();
  } catch (err) {
    logger.runnerError(RUNNER, err.message);
    findings.push(createFinding({
      id: 'integrity-dashboard-runner-error', runner: RUNNER, category: CATEGORY.FUNCTIONAL, severity: SEVERITY.INFO,
      title: `Runner error: ${err.message.slice(0, 80)}`, detail: err.message, evidence: err.stack?.split('\n')[1]?.trim() ?? '', recommendation: 'Re-run and inspect the runner log.'
    }));
    if (browser) await browser.close().catch(() => null);
  }

  const tally = {};
  for (const c of checks) { tally[c.page] ??= { pass: 0, fail: 0, skip: 0, error: 0 }; tally[c.page][c.status]++; }
  metrics.tally = tally;
  return createRunnerResult(RUNNER, config.baseUrl, findings, metrics);
}
