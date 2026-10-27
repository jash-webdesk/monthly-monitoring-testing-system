/**
 * Storefront audits for eCommerce sites (BigCommerce layout by default, selectors come from the site's
 * `storefront` block in projects/*.json). Everything here is read-only against the live site:
 *   - page requests are plain GETs;
 *   - the journeys use a throwaway guest session (add to cart, change quantity, remove, invalid coupon);
 *   - payment, contact and newsletter forms are never submitted, and no email is typed into checkout.
 *
 * Exports (each returns the standard runner result): runAvailability, runJourneys, runResponsive,
 * runAccessibility, runSeoSample, runSecurityExtras.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createFinding, createRunnerResult, SEVERITY, CATEGORY } from '../lib/result.js';
import { launchChromium } from '../lib/browser.js';
import { logger } from '../lib/logger.js';

const UA = 'Mozilla/5.0 (compatible; WebDeskMonitoring/1.0; +https://webdesksolution.com)';

const abs = (base, p) => new URL(p, base).href;

async function pool(items, size, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

async function timedFetch(url, { redirect = 'manual', timeoutMs = 25000 } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect, headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    return { url, status: res.status, location: res.headers.get('location'), ms: Date.now() - started, body, headers: res.headers };
  } catch (err) {
    return { url, status: 0, error: err.cause?.code ?? err.message, ms: Date.now() - started, body: '', headers: new Headers() };
  }
}

/** Collects the links a visitor sees in the header, menus and footer (rendered, so JavaScript menus count). */
export async function collectNavLinks(baseUrl, page) {
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 90000 });
  const host = new URL(baseUrl).hostname;
  const hrefs = await page.$$eval('header a[href], nav a[href], footer a[href], .navPages a[href], .navPages-list a[href]', (as) => as.map((a) => a.getAttribute('href')));
  const set = new Set();
  for (const h of hrefs) {
    if (!h || h.startsWith('#') || /^(mailto:|tel:|javascript:|sms:)/i.test(h)) continue;
    let u;
    try { u = new URL(h, baseUrl); } catch { continue; }
    if (u.hostname !== host) continue;
    u.hash = '';
    set.add(u.href);
  }
  return [...set];
}

// ─── 1. Navigation availability ──────────────────────────────────────────────

export async function runAvailability(baseUrl, cfg = {}) {
  const findings = [];
  const metrics = {};
  const max = cfg.navCrawl?.max ?? 450;
  const concurrency = cfg.navCrawl?.concurrency ?? 6;

  const browser = await launchChromium();
  let links;
  let homepageLoadMs = null;
  try {
    const page = await browser.newPage({ userAgent: UA });
    const t0 = Date.now();
    links = await collectNavLinks(baseUrl, page);
    homepageLoadMs = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return n ? Math.round(n.loadEventEnd) : null;
    }).catch(() => Date.now() - t0);
  } finally { await browser.close(); }
  links = links.slice(0, max);
  logger.info(`  Checking ${links.length} navigation pages (${concurrency} at a time)...`);

  const results = await pool(links, concurrency, async (url) => {
    const first = await timedFetch(url);
    let finalStatus = first.status;
    let redirected = false;
    let hops = 0;
    let current = first;
    while (current.status >= 300 && current.status < 400 && current.location && hops < 5) {
      redirected = true;
      hops++;
      current = await timedFetch(abs(url, current.location));
      finalStatus = current.status;
    }
    return { url, firstStatus: first.status, finalStatus, redirected, hops, ms: first.ms + (current === first ? 0 : current.ms), error: first.error ?? current.error };
  });

  const ok = results.filter((r) => r.finalStatus >= 200 && r.finalStatus < 300);
  const serverErrors = results.filter((r) => r.finalStatus >= 500 || r.finalStatus === 0);
  const clientErrors = results.filter((r) => r.finalStatus >= 400 && r.finalStatus < 500);
  const redirects = results.filter((r) => r.redirected);
  const loops = results.filter((r) => r.hops >= 5);
  const buckets = {
    under1: results.filter((r) => r.ms < 1000).length,
    oneToTwo: results.filter((r) => r.ms >= 1000 && r.ms <= 2000).length,
    over2: results.filter((r) => r.ms > 2000).length
  };
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => ({ url: r.url, ms: r.ms }));

  // 404 handling
  const probe = await timedFetch(abs(baseUrl, `/this-page-does-not-exist-${Date.now().toString(36)}/`), { redirect: 'follow' });
  const friendly = probe.status === 404 && /not\s*found|can.?t find|doesn.?t exist|404/i.test(probe.body) && probe.body.length > 800;
  metrics.errorPage = { status: probe.status, friendly };

  Object.assign(metrics, {
    checked: results.length, ok: ok.length, redirected: redirects.length, clientErrors: clientErrors.length, serverErrors: serverErrors.length,
    buckets, slowest, avgMs: Math.round(results.reduce((s, r) => s + r.ms, 0) / Math.max(1, results.length)), homepageLoadMs, pages: results
  });

  if (serverErrors.length) {
    findings.push(createFinding({ id: 'availability-server-errors', runner: 'availability', category: CATEGORY.AVAILABILITY, severity: SEVERITY.HIGH,
      title: `${serverErrors.length} navigation page${serverErrors.length === 1 ? '' : 's'} returned a server error or did not respond`,
      detail: 'Pages linked from the menus or footer failed to load. Visitors who click these links see an error.',
      evidence: serverErrors.slice(0, 5).map((r) => `${r.url} (${r.finalStatus || r.error})`).join('; '), recommendation: 'Check the server logs for these addresses and restore the pages or remove the links.' }));
  }
  if (clientErrors.length) {
    findings.push(createFinding({ id: 'availability-broken-links', runner: 'availability', category: CATEGORY.AVAILABILITY, severity: SEVERITY.MEDIUM,
      title: `${clientErrors.length} navigation link${clientErrors.length === 1 ? '' : 's'} lead to a "not found" or blocked page`,
      detail: 'Menu or footer links point to pages that no longer exist.',
      evidence: clientErrors.slice(0, 5).map((r) => `${r.url} (${r.finalStatus})`).join('; '), recommendation: 'Update or remove the broken links in the menu and footer.' }));
  }
  if (loops.length) {
    findings.push(createFinding({ id: 'availability-redirect-chain', runner: 'availability', category: CATEGORY.AVAILABILITY, severity: SEVERITY.MEDIUM,
      title: `${loops.length} navigation link${loops.length === 1 ? '' : 's'} pass through many redirects`,
      detail: 'Long redirect chains slow pages down and can confuse search engines.', evidence: loops.slice(0, 5).map((r) => r.url).join('; '), recommendation: 'Point these links straight at the final page.' }));
  }
  if (redirects.length) {
    findings.push(createFinding({ id: 'availability-redirecting-links', runner: 'availability', category: CATEGORY.AVAILABILITY, severity: SEVERITY.LOW,
      title: `${redirects.length} navigation link${redirects.length === 1 ? '' : 's'} redirect to a newer address`,
      detail: 'The pages work, but the link in the menu is not the current address.', evidence: redirects.slice(0, 5).map((r) => r.url).join('; '), recommendation: 'Update the links to the current addresses to save a redirect on each visit.' }));
  }
  if (buckets.over2 > 0) {
    findings.push(createFinding({ id: 'availability-slow-pages', runner: 'availability', category: CATEGORY.PERFORMANCE, severity: SEVERITY.LOW,
      title: `${buckets.over2} page${buckets.over2 === 1 ? '' : 's'} took longer than 2 seconds to respond`,
      detail: 'Response time was measured from this monitoring location in one pass.', evidence: slowest.map((r) => `${r.url} (${r.ms} ms)`).join('; '), recommendation: 'Review caching for the slowest pages.' }));
  }
  if (!friendly) {
    findings.push(createFinding({ id: 'availability-error-page', runner: 'availability', category: CATEGORY.AVAILABILITY, severity: SEVERITY.MEDIUM,
      title: 'The "page not found" screen is not clear or does not return the right status',
      detail: 'A mistyped address should show a helpful message and a 404 status.', evidence: `Status ${probe.status}, ${probe.body.length} bytes`, recommendation: 'Make sure the 404 page explains the problem and links back to the store.' }));
  }
  return createRunnerResult('availability', baseUrl, findings, metrics);
}

// ─── 2. Customer journeys ────────────────────────────────────────────────────

/** Runs one journey step. A failed step is retried once, so a slow page does not raise a false alarm. */
async function step(journeys, name, fn, { retry = true } = {}) {
  const started = Date.now();
  let lastError;
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    try {
      const detail = await fn();
      journeys.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - started, attempts: attempt + 1 });
      return true;
    } catch (err) {
      lastError = err;
    }
  }
  journeys.push({ name, ok: false, detail: String(lastError.message).split('\n')[0], ms: Date.now() - started, attempts: retry ? 2 : 1 });
  return false;
}

export async function runJourneys(baseUrl, cfg = {}, evidenceDir) {
  const findings = [];
  const journeys = [];
  const evidence = {};
  mkdirSync(evidenceDir, { recursive: true });
  const shot = async (page, name, opts = {}) => {
    const p = join(evidenceDir, `${name}.jpg`);
    await page.screenshot({ path: p, type: 'jpeg', quality: 88, ...opts });
    evidence[name] = p;
  };
  const sf = { searchPath: '/search.php', searchParam: 'search_query', loginPath: '/login.php', cartPath: '/cart.php', checkoutPath: '/checkout', addToCartSelector: '#form-action-addToCart', ...cfg };
  const terms = { valid: 'swaddle', partial: 'swad', none: 'zzqxjkvw', unusual: '<script>alert(1)</script> "\' &', ...(cfg.searchTerms ?? {}) };

  const browser = await launchChromium();
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: UA });
  const page = await context.newPage();
  const consoleErrors = [];
  const builder = {};
  page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 160)));

  try {
    // Search (valid, partial, no result, unusual characters)
    for (const [kind, term] of Object.entries(terms)) {
      await step(journeys, `search-${kind}`, async () => {
        const url = abs(baseUrl, `${sf.searchPath}?${sf.searchParam}=${encodeURIComponent(term)}`);
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status()}`);
        await page.waitForLoadState('networkidle').catch(() => null);
        const cards = await page.locator('.product, .card, li.product').count();
        if (kind === 'valid' || kind === 'partial') { if (cards === 0) throw new Error('no results shown'); return `${cards} result cards`; }
        if (kind === 'unusual') {
          const html = await page.content();
          if (html.includes('<script>alert(1)</script>')) throw new Error('search text was written back to the page unescaped');
          return 'handled safely';
        }
        return 'handled without error';
      });
    }

    // Category browsing from the menu
    await step(journeys, 'category-browse', async () => {
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60000 });
      const href = await page.$$eval('.navPages a[href], nav a[href]', (as) => as.map((a) => a.getAttribute('href')).find((h) => h && /\/[a-z0-9-]+\/[a-z0-9-]+\/?$/i.test(h) && !/login|cart|compare|about|impact|personal/i.test(h)) ?? null);
      if (!href) throw new Error('no category link found');
      const res = await page.goto(abs(baseUrl, href), { waitUntil: 'networkidle', timeout: 60000 });
      if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status()}`);
      const cards = await page.locator('.product, .card, li.product').count();
      if (!cards) throw new Error('no products shown');
      return `${cards} products`;
    });

    // Gift-basket builder (custom tool): loads, shows its first step, and has a customer-friendly page title
    if (cfg.builderPath) {
      await step(journeys, 'gift-basket-builder', async () => {
        const errorsBefore = consoleErrors.length;
        const res = await page.goto(abs(baseUrl, cfg.builderPath), { waitUntil: 'networkidle', timeout: 90000 });
        if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status()}`);
        await page.waitForTimeout(1500);
        // The builder's first step is a set of large picture tiles (the page headline is an image, not text).
        const tiles = await page.locator('img:visible').evaluateAll((imgs) => imgs.filter((i) => i.naturalWidth > 200).length);
        if (tiles < 3) throw new Error(`builder first step shows only ${tiles} picture choices`);
        builder.choices = tiles;
        const title = await page.title();
        builder.title = title;
        builder.scriptErrors = consoleErrors.slice(errorsBefore);
        builder.internalTitle = /(test|draft|untitled|staging|lorem|copy of|new page)/i.test(title);
        return `first step shows ${tiles} choices; ${builder.scriptErrors.length} script error(s)`;
      });
    }

    // Product page + add to cart
    let added = false;
    await step(journeys, 'product-page', async () => {
      const res = await page.goto(abs(baseUrl, cfg.sampleProduct ?? '/'), { waitUntil: 'networkidle', timeout: 60000 });
      if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status()}`);
      if (!(await page.locator('h1').first().isVisible())) throw new Error('product title missing');
      if (!(await page.locator(sf.addToCartSelector).count())) throw new Error('add-to-cart button missing');
      return 'title, price and add-to-cart present';
    });
    added = await step(journeys, 'add-to-cart', async () => {
      await page.click(sf.addToCartSelector);
      const msg = page.getByText(/added to your cart/i).first();
      await msg.waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForTimeout(800);
      await shot(page, 'add-to-cart');
      return 'confirmation pop-up shown';
    });

    // Cart: quantity, coupon, remove
    await step(journeys, 'cart-page', async () => {
      const res = await page.goto(abs(baseUrl, sf.cartPath), { waitUntil: 'networkidle', timeout: 60000 });
      if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status()}`);
      const items = await page.locator('.cart-item').count();
      if (added && items < 1) throw new Error('item missing from cart');
      return `${items} item in cart`;
    });
    await step(journeys, 'cart-quantity', async () => {
      const total = async () => (await page.locator('.cart-total, .cart-totals').first().innerText()).replace(/\s+/g, ' ');
      const before = await total();
      await page.locator('[data-action="inc"]').first().click();
      await page.waitForTimeout(2500);
      const after = await total();
      if (before === after) throw new Error('totals did not change when the quantity increased');
      await page.locator('[data-action="dec"]').first().click();
      await page.waitForTimeout(2500);
      return 'totals updated correctly';
    });
    await step(journeys, 'invalid-coupon', async () => {
      await page.getByText(/add coupon/i).first().click();
      const box = page.locator('#couponcode, input[name="couponcode"]').first();
      await box.waitFor({ state: 'visible', timeout: 8000 });
      await box.fill('INVALID-MONITORING-TEST');
      await box.press('Enter');
      const msg = page.getByText(/not valid|invalid|expired|no longer/i).first();
      await msg.waitFor({ state: 'visible', timeout: 12000 });
      await page.waitForTimeout(500);
      await shot(page, 'invalid-coupon');
      return 'clear message shown';
    });

    // Checkout page: view only. Nothing is typed or submitted.
    await step(journeys, 'guest-checkout', async () => {
      await page.keyboard.press('Escape').catch(() => null);
      const res = await page.goto(abs(baseUrl, sf.checkoutPath), { waitUntil: 'networkidle', timeout: 90000 });
      if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status()}`);
      await page.waitForTimeout(2500);
      const text = (await page.locator('body').innerText()).slice(0, 4000);
      if (!/order summary|customer|checkout/i.test(text)) throw new Error('checkout screen did not load');
      await shot(page, 'guest-checkout');
      return 'checkout screen loads (not submitted)';
    });

    // Remove from cart
    await step(journeys, 'cart-remove', async () => {
      await page.goto(abs(baseUrl, sf.cartPath), { waitUntil: 'networkidle', timeout: 60000 });
      const remove = page.locator('.cart-remove').first();
      if (!(await remove.count())) throw new Error('remove control not found');
      await remove.click();
      // The store asks "Are you sure you want to delete this item?" and waits for OK.
      const confirm = page.getByText(/are you sure/i).first();
      if (await confirm.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false)) {
        await page.getByRole('button', { name: /^ok$/i }).first().click();
      }
      await page.waitForTimeout(3500);
      const empty = (await page.locator('body').innerText()).match(/your cart is empty|cart is empty|no items/i);
      if (!empty) throw new Error('cart did not empty after removing the item');
      return 'item removed, cart empty';
    });

    // Sign-in validation: empty and wrong details only
    await step(journeys, 'signin-empty', async () => {
      await page.goto(abs(baseUrl, sf.loginPath), { waitUntil: 'networkidle', timeout: 60000 });
      const submit = page.locator('form[action*="login"] input[type="submit"], form[action*="login"] button[type="submit"]').first();
      await submit.click();
      const msg = page.getByText(/required|enter your|please/i).first();
      await msg.waitFor({ state: 'visible', timeout: 8000 });
      return 'clear message shown';
    });
    await step(journeys, 'signin-invalid', async () => {
      await page.goto(abs(baseUrl, sf.loginPath), { waitUntil: 'networkidle', timeout: 60000 });
      await page.locator('input[name="login_email"], #login_email').first().fill('monitoring-test@example.invalid');
      await page.locator('input[name="login_pass"], #login_pass').first().fill('not-a-real-password');
      await page.locator('form[action*="login"] input[type="submit"], form[action*="login"] button[type="submit"]').first().click();
      const msg = page.getByText(/incorrect|invalid|not recognized|do not match/i).first();
      await msg.waitFor({ state: 'visible', timeout: 12000 });
      return 'clear message shown';
    });
  } finally {
    await context.close();
    await browser.close();
  }

  const failed = journeys.filter((j) => !j.ok);
  for (const j of failed) {
    findings.push(createFinding({ id: `journey-${j.name}`, runner: 'functional', category: CATEGORY.FUNCTIONAL, severity: /cart|checkout|add-to-cart|product/.test(j.name) ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      title: `Customer journey step did not complete: ${j.name.replace(/-/g, ' ')}`,
      detail: 'An automated visitor could not complete this step on the live store.', evidence: j.detail, recommendation: 'Repeat the step by hand and check the page, then fix the cause.' }));
  }
  if (builder.scriptErrors?.length) {
    findings.push(createFinding({ id: 'journey-builder-script-errors', runner: 'functional', category: CATEGORY.FUNCTIONAL, severity: SEVERITY.LOW,
      title: `The gift-basket builder shows ${new Set(builder.scriptErrors).size} script error${new Set(builder.scriptErrors).size === 1 ? '' : 's'} when it loads`,
      detail: 'The builder still loads, but script errors can stop a part of it from working.', evidence: [...new Set(builder.scriptErrors)].slice(0, 3).join(' | '), recommendation: 'Have a developer fix the errors in the builder scripts.' }));
  }
  if (builder.internalTitle) {
    findings.push(createFinding({ id: 'journey-builder-internal-title', runner: 'functional', category: CATEGORY.FUNCTIONAL, severity: SEVERITY.LOW,
      title: 'The gift-basket builder page has an internal-looking title', detail: 'The browser tab and search results show a working title instead of a customer-friendly one.', evidence: `Page title: "${builder.title}"`, recommendation: 'Give the builder page a clear public title.' }));
  }
  // Errors already reported for the builder are not counted again.
  const otherErrors = consoleErrors.filter((e) => !(builder.scriptErrors ?? []).includes(e));
  if (otherErrors.length) {
    findings.push(createFinding({ id: 'journey-script-errors', runner: 'functional', category: CATEGORY.FUNCTIONAL, severity: SEVERITY.LOW,
      title: `${new Set(otherErrors).size} script error${new Set(otherErrors).size === 1 ? '' : 's'} appeared during the customer journeys`,
      detail: 'Script errors can quietly stop a feature from working.', evidence: [...new Set(otherErrors)].slice(0, 4).join(' | '), recommendation: 'Have a developer review the script errors.' }));
  }
  return createRunnerResult('functional', baseUrl, findings, { journeys, evidence, builder, passed: journeys.filter((j) => j.ok).length, total: journeys.length });
}

// ─── 3. Responsive layout ────────────────────────────────────────────────────

export async function runResponsive(baseUrl, cfg = {}, evidenceDir) {
  const findings = [];
  mkdirSync(evidenceDir, { recursive: true });
  const evidence = {};
  const views = [
    { key: 'desktop', width: 1366, height: 778, path: cfg.sampleProduct ?? '/' },
    { key: 'tablet', width: 820, height: 1114, path: cfg.aboutPath ?? '/about-us/' },
    { key: 'mobile', width: 390, height: 844, path: '/' }
  ];
  const checks = [];
  const browser = await launchChromium();
  try {
    for (const v of views) {
      const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, isMobile: v.key === 'mobile', hasTouch: v.key !== 'desktop', userAgent: UA });
      const page = await ctx.newPage();
      const res = await page.goto(abs(baseUrl, v.path), { waitUntil: 'networkidle', timeout: 90000 });
      await page.waitForTimeout(1200);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      checks.push({ view: v.key, status: res?.status(), sideways });
      const p = join(evidenceDir, `responsive-${v.key}.jpg`);
      await page.screenshot({ path: p, type: 'jpeg', quality: 88 });
      evidence[v.key] = p;
      if (v.key === 'mobile' && cfg.builderPath) {
        const bp = await ctx.newPage();
        const br = await bp.goto(abs(baseUrl, cfg.builderPath), { waitUntil: 'networkidle', timeout: 90000 }).catch(() => null);
        await bp.waitForTimeout(1200);
        const bSideways = await bp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2).catch(() => null);
        checks.push({ view: 'mobile-builder', status: br?.status() ?? 0, sideways: Boolean(bSideways) });
        await bp.close();
      }
      if (v.key === 'mobile') {
        const toggle = page.locator('.mobileMenu-toggle, [aria-label*="menu" i], .navUser-action--menu, #menu').first();
        if (await toggle.count()) {
          await toggle.click({ timeout: 5000 }).catch(() => null);
          await page.waitForTimeout(1200);
          const mp = join(evidenceDir, 'responsive-mobile-menu.jpg');
          await page.screenshot({ path: mp, type: 'jpeg', quality: 88 });
          evidence['mobile-menu'] = mp;
          checks.push({ view: 'mobile-menu', opened: true });
        } else { checks.push({ view: 'mobile-menu', opened: false }); }
      }
      await ctx.close();
    }
  } finally { await browser.close(); }

  for (const c of checks.filter((x) => x.sideways)) {
    findings.push(createFinding({ id: `responsive-sideways-${c.view}`, runner: 'responsive', category: CATEGORY.RESPONSIVE, severity: SEVERITY.MEDIUM,
      title: `The ${c.view} layout scrolls sideways`, detail: 'Part of the page is wider than the screen, so visitors have to scroll sideways.', evidence: `${c.view} view`, recommendation: 'Find the element that is wider than the screen and make it fit.' }));
  }
  if (checks.some((c) => c.view === 'mobile-menu' && !c.opened)) {
    findings.push(createFinding({ id: 'responsive-mobile-menu', runner: 'responsive', category: CATEGORY.RESPONSIVE, severity: SEVERITY.LOW,
      title: 'The mobile menu button could not be found by the automated check', detail: 'The check could not open the phone menu.', evidence: 'mobile view', recommendation: 'Confirm by hand that the phone menu opens.' }));
  }
  return createRunnerResult('responsive', baseUrl, findings, { checks, evidence, screens: 3 });
}

// ─── 4. Accessibility (basic automated checks) ───────────────────────────────

export async function runAccessibility(baseUrl, cfg = {}) {
  const findings = [];
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const paths = cfg.accessibilityPages ?? ['/', cfg.sampleProduct ?? '/', cfg.cartPath ?? '/cart.php', cfg.loginPath ?? '/login.php'];
  const rules = new Map();
  const browser = await launchChromium();
  let pagesChecked = 0;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, userAgent: UA });
    for (const p of paths) {
      const page = await ctx.newPage();
      try {
        await page.goto(abs(baseUrl, p), { waitUntil: 'networkidle', timeout: 90000 });
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        pagesChecked++;
        for (const v of r.violations) {
          const e = rules.get(v.id) ?? { id: v.id, impact: v.impact, help: v.help, nodes: 0, pages: new Set() };
          e.nodes += v.nodes.length; e.pages.add(p);
          rules.set(v.id, e);
        }
      } catch (err) { logger.warn(`  Accessibility check skipped for ${p}: ${err.message.split('\n')[0]}`); }
      finally { await page.close(); }
    }
  } finally { await browser.close(); }
  const sevOf = (impact) => (impact === 'critical' ? SEVERITY.HIGH : impact === 'serious' ? SEVERITY.MEDIUM : SEVERITY.LOW);
  for (const r of rules.values()) {
    findings.push(createFinding({ id: `a11y-${r.id}`, runner: 'accessibility', category: CATEGORY.ACCESSIBILITY, severity: sevOf(r.impact),
      title: `Accessibility: ${r.help}`, detail: 'An automated accessibility check found this on one or more pages. Fixing it makes the site easier for everyone to use.',
      evidence: `${r.nodes} element(s) on ${[...r.pages].join(', ')}`, recommendation: 'Fix the flagged elements (see the rule on dequeuniversity.com/rules/axe).', wcag: null }));
  }
  return createRunnerResult('accessibility', baseUrl, findings, { pagesChecked, rules: [...rules.values()].map((r) => ({ id: r.id, impact: r.impact, nodes: r.nodes, pages: [...r.pages] })) });
}

// ─── 5. SEO sample ───────────────────────────────────────────────────────────

const meta = (html, re) => (html.match(re) ?? [])[1]?.trim() ?? '';

export function analysePage(html) {
  const headings = [...html.matchAll(/<h1[\s>]/gi)].length;
  const h2 = [...html.matchAll(/<h2[\s>]/gi)].length;
  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const types = new Set();
  for (const block of ld) {
    for (const t of block.matchAll(/"@type"\s*:\s*"([A-Za-z]+)"/g)) types.add(t[1]);
  }
  return {
    title: meta(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description: meta(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || meta(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i),
    canonical: meta(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i),
    ogTitle: meta(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i),
    ogImage: meta(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i),
    robots: meta(html, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i),
    h1: headings, h2,
    structured: [...types]
  };
}

export async function runSeoSample(baseUrl, cfg = {}, navLinks = []) {
  const findings = [];
  const want = cfg.seoSample ?? 19;
  const base = new URL(baseUrl);
  const picked = new Set([abs(baseUrl, '/')]);
  for (const p of [cfg.aboutPath, '/our-impact/', cfg.sampleProduct].filter(Boolean)) picked.add(abs(baseUrl, p));
  const rest = navLinks.filter((u) => !picked.has(u) && new URL(u).hostname === base.hostname && !/login|cart|checkout|compare|account/i.test(u));
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, want - picked.size)));
  for (let i = 0; i < rest.length && picked.size < want; i += step) picked.add(rest[i]);
  const urls = [...picked];

  const pages = await pool(urls, 5, async (url) => {
    const r = await timedFetch(url, { redirect: 'follow' });
    return { url, status: r.status, ...analysePage(r.body) };
  });

  const ok = pages.filter((p) => p.status === 200);
  const noDesc = ok.filter((p) => !p.description);
  const noTitle = ok.filter((p) => !p.title);
  const noCanonical = ok.filter((p) => !p.canonical);
  const noOg = ok.filter((p) => !p.ogTitle || !p.ogImage);
  const noIndex = ok.filter((p) => /noindex/i.test(p.robots));
  const badH1 = ok.filter((p) => p.h1 !== 1);
  const structuredCount = ok.filter((p) => p.structured.length).length;
  const types = [...new Set(ok.flatMap((p) => p.structured))];

  const add = (id, severity, title, list, detail, recommendation) => {
    if (!list.length) return;
    findings.push(createFinding({ id, runner: 'seo', category: CATEGORY.SEO, severity, title, detail, evidence: list.slice(0, 5).map((p) => p.url).join('; '), recommendation }));
  };
  add('seo-sample-missing-description', SEVERITY.MEDIUM, `${noDesc.length} of ${ok.length} sampled pages have no meta description`, noDesc, 'Search results show a generic snippet instead of a written summary.', 'Add a short description to each page.');
  add('seo-sample-missing-title', SEVERITY.MEDIUM, `${noTitle.length} sampled page(s) have no title`, noTitle, 'Pages without a title are harder to find and recognise.', 'Add a clear title to each page.');
  add('seo-sample-headings', SEVERITY.LOW, `${badH1.length} sampled page(s) have a missing or repeated main heading`, badH1, 'Each page should have exactly one main heading.', 'Use one main heading per page.');
  add('seo-sample-missing-canonical', SEVERITY.LOW, `${noCanonical.length} sampled page(s) have no canonical address`, noCanonical, 'A canonical address tells search engines which version of a page to list.', 'Add a canonical link to each page.');
  add('seo-sample-social-tags', SEVERITY.LOW, `${noOg.length} sampled page(s) are missing social sharing tags`, noOg, 'Shared links may appear without a proper title or image.', 'Add sharing tags (title and image).');
  add('seo-sample-noindex', SEVERITY.MEDIUM, `${noIndex.length} sampled page(s) are blocked from search engines`, noIndex, 'These pages tell search engines not to list them.', 'Confirm this is intended.');

  return createRunnerResult('seo_sample', baseUrl, findings, {
    sampled: pages.length, ok: ok.length, missingDescription: noDesc.length, missingTitle: noTitle.length, headingIssues: badH1.length, missingCanonical: noCanonical.length,
    missingSocialTags: noOg.length, blockedFromSearch: noIndex.length, withStructuredData: structuredCount, structuredTypes: types, pages
  });
}

// ─── 6. Security extras ──────────────────────────────────────────────────────

export async function runSecurityExtras(baseUrl, cfg = {}, searchReflection = null) {
  const findings = [];
  const u = new URL(baseUrl);
  // Plain-web address should redirect to HTTPS
  const plain = await timedFetch(`http://${u.hostname}/`, { redirect: 'manual', timeoutMs: 20000 });
  const toHttps = plain.status >= 300 && plain.status < 400 && /^https:/i.test(plain.location ?? '');
  // Mixed content on a few pages
  const mixed = [];
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    for (const p of ['/', cfg.sampleProduct ?? '/', cfg.cartPath ?? '/cart.php']) {
      const page = await ctx.newPage();
      page.on('request', (r) => { if (/^http:\/\//i.test(r.url())) mixed.push(r.url().slice(0, 120)); });
      await page.goto(abs(baseUrl, p), { waitUntil: 'networkidle', timeout: 60000 }).catch(() => null);
      await page.close();
    }
  } finally { await browser.close(); }

  if (!toHttps) {
    findings.push(createFinding({ id: 'security-http-redirect', runner: 'security', category: CATEGORY.SECURITY, severity: SEVERITY.MEDIUM, title: 'The plain-web address does not redirect to the secure address',
      detail: 'Visitors who type the address without https could stay on an unprotected connection.', evidence: `http:// returned status ${plain.status}`, recommendation: 'Redirect all http:// addresses to https://.', owasp: 'A02' }));
  }
  if (mixed.length) {
    findings.push(createFinding({ id: 'security-mixed-content', runner: 'security', category: CATEGORY.SECURITY, severity: SEVERITY.MEDIUM, title: `${new Set(mixed).size} insecure resource(s) load on secure pages`,
      detail: 'Parts of a secure page load over an unprotected connection.', evidence: [...new Set(mixed)].slice(0, 4).join('; '), recommendation: 'Load these resources over https.', owasp: 'A02' }));
  }
  return createRunnerResult('security_extras', baseUrl, findings, { httpRedirectsToHttps: toHttps, mixedContent: [...new Set(mixed)].length });
}
