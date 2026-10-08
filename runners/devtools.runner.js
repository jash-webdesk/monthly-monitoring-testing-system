/**
 * devtools.runner.js — Phase 3: Browser & Functional Layer
 *
 * Uses Playwright + Chrome DevTools Protocol (CDP) session to capture:
 *  - Full network traffic (request/response headers, status codes, timing)
 *  - Console errors and warnings with stack traces
 *  - Security response headers (CSP, HSTS, COOP, X-Frame-Options, etc.)
 *  - Cookie flags (HttpOnly, Secure, SameSite) per cookie
 *  - JWT tokens in cookies/localStorage — decoded header inspection
 *  - SRI check — external <script> tags missing integrity attribute
 *  - Known-vulnerable JavaScript library scan (Retire.js CVE database — OWASP A03)
 *  - Third-party script inventory
 *
 * Runs in two modes:
 *  1. Guest mode  — no session, clean browser context (always runs)
 *  2. Auth mode   — with provided credentials (runs only if --auth is given)
 */

import { launchChromium } from '../lib/browser.js';
import { createFinding, createErrorFinding, createRunnerResult, SEVERITY, CATEGORY } from '../lib/result.js';
import { logger } from '../lib/logger.js';
import { getArchivePath } from '../lib/archive.js';
import { getOwaspMapping } from './lib/owasp.js';
import { scanScriptsForVulnerabilities } from './lib/retirejs.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

/** Looks up the OWASP Top 10:2025 code for a check_id — single source of truth, see lib/owasp.js. */
const owaspCode = (checkId) => getOwaspMapping(checkId).owasp;

const RUNNER_NAME    = 'devtools';
const NAV_TIMEOUT    = 45_000;  // 45s navigation timeout
const IDLE_WAIT_MS   = 4_000;   // extra wait after load for async requests

/**
 * Security headers to audit with finding metadata.
 * Key = exact lowercase header name as it appears in HTTP response.
 */
// owasp codes below are resolved via getOwaspMapping(checkId) at finding-creation time
// (see generateHeaderFindings) — checkId strings must match lib/owasp.js's OWASP_MAP keys
// exactly. Do not hardcode an owasp letter/number here; that's what caused this table to
// silently drift onto stale 2021-era codes while lib/owasp.js's own 2025 mapping sat unused.
const SECURITY_HEADERS = {
  'content-security-policy': {
    name:     'Content Security Policy (CSP)',
    severity: SEVERITY.HIGH,
    checkId:  'security.csp-missing',
    detail:   'CSP instructs the browser which content sources are trusted. Without it, any injected script — from a compromised ad, third-party CDN, or XSS payload — runs freely in your customers\' browsers.',
    rec:      'Add a Content-Security-Policy header. Start with: default-src \'self\'; script-src \'self\' and expand only as needed.'
  },
  'strict-transport-security': {
    name:     'HTTP Strict Transport Security (HSTS)',
    severity: SEVERITY.HIGH,
    checkId:  'ssl.hsts-missing',
    detail:   'HSTS forces browsers to always use HTTPS for future visits. Without it, a first-time visitor can be targeted with an SSL-stripping attack that silently downgrades their connection to HTTP.',
    rec:      'Add: Strict-Transport-Security: max-age=31536000; includeSubDomains; preload'
  },
  'x-frame-options': {
    name:     'X-Frame-Options',
    severity: SEVERITY.MEDIUM,
    checkId:  'security.x-frame-options-missing',
    detail:   'Prevents the site from being embedded in iframes on other domains, blocking clickjacking attacks where an attacker tricks users into clicking hidden UI elements.',
    rec:      'Add: X-Frame-Options: SAMEORIGIN  (or use CSP frame-ancestors \'self\')'
  },
  'x-content-type-options': {
    name:     'X-Content-Type-Options',
    severity: SEVERITY.MEDIUM,
    checkId:  'security.x-content-type-options-missing',
    detail:   'Prevents MIME-type sniffing. Without it, browsers may interpret files as a different type than declared (e.g., running a text file as JavaScript).',
    rec:      'Add: X-Content-Type-Options: nosniff'
  },
  'referrer-policy': {
    name:     'Referrer-Policy',
    severity: SEVERITY.LOW,
    checkId:  'security.referrer-policy-missing',
    detail:   'Controls how much referrer information is sent when a user navigates away. Without it, full URLs (including order IDs or search terms) may leak to third-party analytics.',
    rec:      'Add: Referrer-Policy: strict-origin-when-cross-origin'
  },
  'permissions-policy': {
    name:     'Permissions-Policy',
    severity: SEVERITY.LOW,
    checkId:  'security.permissions-policy-missing',
    detail:   'Restricts which browser APIs (camera, microphone, geolocation) scripts on the page can access. Without it, third-party scripts have unrestricted access.',
    rec:      'Add: Permissions-Policy: geolocation=(), microphone=(), camera=()'
  },
  'cross-origin-opener-policy': {
    name:     'Cross-Origin-Opener-Policy (COOP)',
    severity: SEVERITY.MEDIUM,
    checkId:  'security.coop-missing',
    detail:   'COOP isolates the browsing context, preventing cross-origin pages opened in popups from accessing the window object of this page.',
    rec:      'Add: Cross-Origin-Opener-Policy: same-origin'
  }
};

/** Cookie names considered security-sensitive */
const SENSITIVE_COOKIE_PATTERNS = [
  /^PHPSESSID$/i, /^JSESSIONID$/i, /^session/i, /^auth/i,
  /^token$/i, /^SHOP_/i, /^_secure/i, /^_session/i,
  /^connect\.sid$/i, /^DEVICE_TOKEN/i
];

// ── Public export ──────────────────────────────────────────────────

/**
 * Runs the Phase 3 browser & functional audit.
 * Always runs guest mode. Runs authenticated mode only if authConfig is provided.
 *
 * @param {string}      url        - Full URL e.g. "https://partsconnexion.com/"
 * @param {string}      hostname   - Domain hostname
 * @param {string|null} month      - YYYY-MM for archive path (screenshots)
 * @param {string|null} authFile   - Path to auth credentials JSON (optional)
 * @returns {Promise<Object>} Runner result envelope
 */
export async function runDevtools(url, hostname, month = null, authFile = null) {
  logger.runnerStart(RUNNER_NAME);

  if (!url || !hostname) {
    const result = createRunnerResult(RUNNER_NAME, url ?? '', [
      createErrorFinding(RUNNER_NAME, 'url and hostname are required')
    ]);
    logger.runnerDone(RUNNER_NAME, 1);
    return result;
  }

  const findings = [];
  const metrics  = {
    hostname,
    url,
    capturedAt:        new Date().toISOString(),
    guestMode:         null,
    authenticatedMode: null
  };

  let browser = null;
  try {
    browser = await launchChromium({
      headless: true,
      args:     ['--no-sandbox', '--disable-dev-shm-usage']
    });

    // ── PASS 1: Guest mode ─────────────────────────────────────
    logger.info('  Pass 1: Guest mode audit...');
    const guestData = await runBrowserPass(browser, url, hostname, month, 'guest', null);
    metrics.guestMode = guestData.metrics;
    findings.push(...guestData.findings);

    // ── PASS 2: Authenticated mode (optional) ──────────────────
    let authConfig = null;
    if (authFile) {
      authConfig = loadAuthConfig(authFile);
    } else if ((process.env.STOREFRONT_USERNAME ?? process.env.USERNAME) && (process.env.STOREFRONT_PASSWORD ?? process.env.PASSWORD)) {
      // STOREFRONT_* is preferred; bare USERNAME/PASSWORD remain supported for older .env files.
      authConfig = {
        username: process.env.STOREFRONT_USERNAME ?? process.env.USERNAME,
        password: process.env.STOREFRONT_PASSWORD ?? process.env.PASSWORD,
        loginUrl: `${url.endsWith('/') ? url : url + '/'}login.php`
      };
      logger.info('  Found credentials in .env file. Enabling Authenticated mode...');
    }

    if (authConfig) {
      logger.info('  Pass 2: Authenticated mode audit...');
      const authData = await runBrowserPass(browser, url, hostname, month, 'auth', authConfig);
      metrics.authenticatedMode = authData.metrics;
      // Page-level checks (security headers, HSTS) come from the raw HTTP response and
      // do not change based on login state — guest and auth passes report the identical
      // finding. Skip re-adding those as duplicates; only keep auth findings that are
      // genuinely distinct from what the guest pass already found (different title —
      // e.g. a different cookie/script count while logged in).
      const guestTitles = new Set(guestData.findings.map(f => f.title));
      for (const f of authData.findings) {
        if (guestTitles.has(f.title)) continue;
        findings.push({ ...f, id: `auth-${f.id}` });
      }
    } else {
      logger.info('  Pass 2: Authenticated mode skipped (no credentials provided)');
    }

  } catch (err) {
    findings.push(createErrorFinding(RUNNER_NAME, err.message));
    logger.runnerError(RUNNER_NAME, err.message);
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }

  const result = createRunnerResult(RUNNER_NAME, url, findings, metrics);
  logger.runnerDone(RUNNER_NAME, findings.length);
  return result;
}

// ── Core browser pass (shared between guest and auth) ─────────────

/**
 * Runs one full browser audit pass using Playwright + CDP session.
 * CDP gives us the same raw network/console data as Chrome DevTools MCP.
 *
 * @param {Object}      browser    - Playwright browser instance (already launched)
 * @param {string}      url        - Target URL
 * @param {string}      hostname   - Domain hostname
 * @param {string|null} month      - YYYY-MM for screenshot path
 * @param {'guest'|'auth'} mode    - Audit mode label
 * @param {Object|null} authConfig - Auth credentials (null for guest)
 * @returns {Promise<{findings: Object[], metrics: Object}>}
 */
async function runBrowserPass(browser, url, hostname, month, mode, authConfig) {
  const passFindings = [];
  const passMetrics  = {
    mode,
    responseHeaders:   {},
    networkRequests:   [],
    networkErrors:     [],
    consoleMessages:   [],
    cookies:           [],
    thirdPartyScripts: [],
    sriViolations:     [],
    jwtTokens:         [],
    screenshotPath:    null
  };

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; MonthlyMonitor/1.0; +https://webdesksolution.com/)',
    ignoreHTTPSErrors: true  // We already check cert separately in ssl.runner.js
  });

  const page = await context.newPage();

  // ── Open CDP session — Chrome DevTools Protocol raw access ───
  // This gives us the same data as Chrome DevTools MCP tools:
  //   Network.responseReceived  → list_network_requests
  //   Network.requestWillBeSent → request details
  //   Console.messageAdded      → list_console_messages
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Console.enable');
  await cdp.send('Runtime.enable');

  // Raw CDP event listeners (equivalent to Chrome DevTools MCP data)
  const cdpNetworkLog = new Map(); // requestId → request details
  const cdpConsole    = [];

  cdp.on('Network.requestWillBeSent', (event) => {
    cdpNetworkLog.set(event.requestId, {
      url:       event.request.url,
      method:    event.request.method,
      headers:   event.request.headers,
      timestamp: event.timestamp
    });
  });

  cdp.on('Network.responseReceived', (event) => {
    const req = cdpNetworkLog.get(event.requestId) ?? {};
    cdpNetworkLog.set(event.requestId, {
      ...req,
      status:          event.response.status,
      statusText:      event.response.statusText,
      responseHeaders: event.response.headers,
      mimeType:        event.response.mimeType,
      timing:          event.response.timing ?? null
    });

    // Capture main document response headers
    if (event.type === 'Document' && Object.keys(passMetrics.responseHeaders).length === 0) {
      // Normalise header keys to lowercase
      const headers = {};
      for (const [k, v] of Object.entries(event.response.headers)) {
        headers[k.toLowerCase()] = v;
      }
      passMetrics.responseHeaders = headers;
      logger.debug(`  Captured ${Object.keys(headers).length} response headers from main document`);
    }
  });

  cdp.on('Console.messageAdded', (event) => {
    const msg = event.message;
    cdpConsole.push({
      level:  msg.level,
      text:   msg.text,
      url:    msg.url ?? null,
      line:   msg.line ?? null
    });
  });

  try {
    // ── Authenticated mode: login first ─────────────────────────
    if (authConfig) {
      await performLogin(page, authConfig, url);
    }

    // ── Navigate to target URL ───────────────────────────────────
    logger.info(`  Navigating to ${url}...`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    } catch (navErr) {
      logger.warn(`  networkidle timeout — falling back to load: ${navErr.message}`);
      await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      await page.waitForTimeout(IDLE_WAIT_MS);
    }

    // Extra wait for any async/XHR requests to complete
    await page.waitForTimeout(2000);

    // ── Screenshot ───────────────────────────────────────────────
    try {
      const archiveDir     = getArchivePath(hostname, month);
      mkdirSync(archiveDir, { recursive: true });
      const screenshotPath = join(archiveDir, `screenshot_${mode}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      passMetrics.screenshotPath = screenshotPath;
      logger.info(`  Screenshot saved: screenshot_${mode}.png`);
    } catch (ssErr) {
      logger.warn(`  Screenshot failed: ${ssErr.message}`);
    }

    // ── Build network log from CDP data ──────────────────────────
    passMetrics.networkRequests = [...cdpNetworkLog.values()];
    passMetrics.consoleMessages = cdpConsole;

    // ── Security headers (from CDP main document response) ───────
    generateHeaderFindings(passFindings, passMetrics.responseHeaders, url);
    if (passMetrics.responseHeaders['strict-transport-security']) {
      checkHstsStrength(passFindings, passMetrics.responseHeaders['strict-transport-security']);
    }

    // ── Network errors (4xx / 5xx) ───────────────────────────────
    const networkErrors = passMetrics.networkRequests.filter(r => r.status >= 400);
    passMetrics.networkErrors = networkErrors;
    generateNetworkErrorFindings(passFindings, networkErrors);

    // ── Console errors ───────────────────────────────────────────
    const jsErrors = cdpConsole.filter(m => m.level === 'error' || m.level === 'warning');
    if (jsErrors.length > 0) {
      passFindings.push(createFinding({
        id:             `devtools-${mode}-console-errors`,
        runner:         RUNNER_NAME,
        category:       CATEGORY.FUNCTIONAL,
        severity:       SEVERITY.LOW,
        title:          `${jsErrors.length} JavaScript console error(s) on ${mode} page load`,
        detail:         'Console errors indicate broken JavaScript that may silently break functionality users rely on.',
        evidence:       jsErrors.slice(0, 10).map(m => `[${m.level}] ${m.text}${m.url ? ` (${m.url}:${m.line})` : ''}`).join('\n'),
        recommendation: 'Review and fix each console error. Prioritise errors related to checkout, cart, or account functionality.',
        owasp:          null,
        wcag:           null
      }));
    }

    // ── Cookies ──────────────────────────────────────────────────
    const cookies = await context.cookies();
    passMetrics.cookies = cookies.map(c => ({
      name:     c.name,
      domain:   c.domain,
      httpOnly: c.httpOnly,
      secure:   c.secure,
      sameSite: c.sameSite,
      expires:  c.expires,
      hasValue: !!c.value
    }));
    generateCookieFindings(passFindings, cookies, hostname, mode);

    // ── JWT detection ─────────────────────────────────────────────
    const jwtTokens = detectJwts(cookies);
    passMetrics.jwtTokens = jwtTokens;
    jwtTokens.forEach(jwt => generateJwtFindings(passFindings, jwt, mode));

    // ── SRI check (via Playwright DOM evaluation) ─────────────────
    // Inline scripts (no src) do not need SRI — only external scripts do
    const sriViolations = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script[src]'))
        .filter(s => {
          const src = s.getAttribute('src') ?? '';
          const isExternal = src.startsWith('http') &&
            !src.includes(window.location.hostname);
          return isExternal && !s.hasAttribute('integrity');
        })
        .map(s => ({
          src:          s.getAttribute('src'),
          crossOrigin:  s.getAttribute('crossorigin') ?? null
        }));
    });
    passMetrics.sriViolations = sriViolations;

    if (sriViolations.length > 0) {
      passFindings.push(createFinding({
        id:             `devtools-${mode}-sri-missing`,
        runner:         RUNNER_NAME,
        category:       CATEGORY.SECURITY,
        severity:       SEVERITY.HIGH,
        title:          `${sriViolations.length} external script(s) loaded without Subresource Integrity (SRI)`,
        detail:         'External scripts without SRI hashes can be silently replaced with malicious code if the CDN or third-party host is compromised. This is an A08 supply chain risk — the most common vector for Magecart-style attacks on eCommerce sites.',
        evidence:       sriViolations.map(s => s.src).join('\n'),
        recommendation: 'Add integrity and crossorigin="anonymous" attributes to all external scripts. Generate hashes at https://www.srihash.org/',
        owasp:          owaspCode('security.sri-missing'),
        wcag:           null
      }));
    }

    // ── OWASP A03: Software Supply Chain Failures — known-vulnerable JS libraries ──
    // SRI (above) only catches a script being silently swapped for something malicious;
    // it says nothing about whether the library itself is a known-vulnerable version
    // the site owner never updated. Scans every script actually loaded (same-origin and
    // external) against the Retire.js CVE database — see lib/retirejs.js.
    const allScriptSrcs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(Boolean)
    );
    const vulnerableLibraries = await scanScriptsForVulnerabilities(allScriptSrcs);
    passMetrics.vulnerableLibraries = vulnerableLibraries;

    if (vulnerableLibraries.length > 0) {
      const worstSeverity = vulnerableLibraries.some(f => f.severity === 'critical') ? SEVERITY.CRITICAL
        : vulnerableLibraries.some(f => f.severity === 'high')   ? SEVERITY.HIGH
        : vulnerableLibraries.some(f => f.severity === 'medium') ? SEVERITY.MEDIUM
        : SEVERITY.LOW;

      passFindings.push(createFinding({
        id:             `devtools-${mode}-retire-js-vulnerable-libraries`,
        runner:         RUNNER_NAME,
        category:       CATEGORY.SECURITY,
        severity:       worstSeverity,
        title:          `${vulnerableLibraries.length} known-vulnerable JavaScript librar${vulnerableLibraries.length === 1 ? 'y' : 'ies'} detected`,
        detail:         'One or more JavaScript libraries loaded on this page match a known-vulnerable version in the Retire.js CVE database. These are exploitable directly in the browser, independent of any server-side hardening.',
        evidence:       vulnerableLibraries.map(f =>
          `${f.component}@${f.version} (${f.severity}) — ${f.url}\n  ${f.vulnerabilities.map(v => v.identifiers?.CVE?.join(', ') || v.identifiers?.summary || 'see advisory in library changelog').join('; ')}`
        ).join('\n'),
        recommendation: 'Upgrade each flagged library to a patched version — see evidence above for the specific component, version, and advisory.',
        owasp:          owaspCode('security.retire-js-cve'),
        wcag:           null
      }));
    }

    // ── Third-party scripts inventory (from DOM) ─────────────────
    const thirdParty = await page.evaluate((host) => {
      return [...new Set(
        Array.from(document.querySelectorAll('script[src]'))
          .map(s => s.getAttribute('src'))
          .filter(src => src?.startsWith('http') && !src.includes(host))
          .map(src => { try { return new URL(src).hostname; } catch { return src; } })
      )];
    }, hostname);
    passMetrics.thirdPartyScripts = thirdParty;

    // ── Pillar 9: Analytics & Tag Manager Audit (Internal Dev Report) ──
    const analyticsAudit = await page.evaluate(() => {
      const pageText = document.documentElement.innerHTML;
      const gtmMatch = pageText.match(/GTM-[A-Z0-9]+/i);
      const ga4Match = pageText.match(/G-[A-Z0-9]{8,12}/i);
      const hasMetaPixel = pageText.includes('connect.facebook.net') || pageText.includes('fbevents.js');
      const hasConsentBanner = !!document.querySelector(
        '#onetrust-banner-sdk, .cookie-consent, #cookie-banner, [id*="cookie"], [class*="cookie"], [aria-label*="cookie"]'
      );
      return {
        gtmId: gtmMatch ? gtmMatch[0] : null,
        ga4Id: ga4Match ? ga4Match[0] : null,
        hasMetaPixel,
        hasConsentBanner
      };
    });

    passMetrics.analytics = analyticsAudit;

    if (!analyticsAudit.gtmId && !analyticsAudit.ga4Id) {
      passFindings.push(createFinding({
        id:             `devtools-${mode}-analytics-missing`,
        runner:         RUNNER_NAME,
        category:       CATEGORY.FUNCTIONAL,
        severity:       SEVERITY.MEDIUM,
        title:          `Pillar 9: No GTM or GA4 Analytics snippet detected on ${mode} page`,
        detail:         `Analytics containers (Google Tag Manager or GA4) were not detected in the DOM. Without analytics snippets, conversion tracking and visitor behavior metrics cannot be measured.`,
        evidence:       `GTM ID: ${analyticsAudit.gtmId ?? 'None'} | GA4 ID: ${analyticsAudit.ga4Id ?? 'None'}`,
        recommendation: `Deploy Google Tag Manager (GTM) or GA4 measurement tag to track storefront conversions.`,
        owasp:          null,
        wcag:           null
      }));
    }

  } finally {
    try { await context.close(); } catch { /* ignore */ }
  }

  return { findings: passFindings, metrics: passMetrics };
}

// ── Auth helpers ───────────────────────────────────────────────────

/**
 * Loads auth credentials from a JSON config file.
 *
 * @param {string} filePath - Path to credentials JSON
 * @returns {Object|null} Auth config or null on failure
 */
function loadAuthConfig(filePath) {
  try {
    if (!existsSync(filePath)) {
      logger.warn(`  Auth config not found: ${filePath}`);
      return null;
    }
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    logger.warn(`  Failed to load auth config: ${err.message}`);
    return null;
  }
}

/**
 * Performs a form-based login using credentials from auth config.
 * Gracefully skips if selectors are not found.
 *
 * @param {Object} page       - Playwright page
 * @param {Object} authConfig - { loginUrl, usernameSelector, passwordSelector, submitSelector, username, password }
 * @param {string} siteUrl    - Site base URL (fallback login URL)
 */
export async function performLogin(page, authConfig, siteUrl) {
  const loginUrl = authConfig.loginUrl ?? `${siteUrl}login.php`;
  logger.info(`  Performing login at: ${loginUrl}`);
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const usernameSelector = authConfig.usernameSelector ?? 'input[name="login_email"]';
    const passwordSelector = authConfig.passwordSelector ?? 'input[name="login_pass"]';
    // Some login pages are client-rendered SPAs that take longer to hydrate than
    // fill()'s default 30s auto-wait — wait explicitly and generously for the field
    // to actually be visible before attempting to fill it.
    await page.waitForSelector(usernameSelector, { state: 'visible', timeout: 60_000 });
    await page.fill(usernameSelector, authConfig.username);
    await page.fill(passwordSelector, authConfig.password);
    await page.click(authConfig.submitSelector ?? 'button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
    logger.info('  Login completed');
  } catch (err) {
    logger.warn(`  Login flow failed: ${err.message} — continuing without auth`);
  }
}

// ── Finding generators ─────────────────────────────────────────────

/**
 * Generates findings for missing or misconfigured security response headers.
 * Missing header (undefined/null) is treated as absent — not as empty string.
 */
function generateHeaderFindings(findings, headers, url) {
  for (const [headerKey, meta] of Object.entries(SECURITY_HEADERS)) {
    const value = headers[headerKey];
    if (value === undefined || value === null || value.trim() === '') {
      findings.push(createFinding({
        id:             `devtools-missing-${headerKey.replace(/[^a-z0-9]+/g, '-')}`,
        runner:         RUNNER_NAME,
        category:       CATEGORY.SECURITY,
        severity:       meta.severity,
        title:          `Missing security header: ${meta.name}`,
        detail:         meta.detail,
        evidence:       `Header "${headerKey}" absent from HTTP response of ${url}`,
        recommendation: meta.rec,
        owasp:          owaspCode(meta.checkId),
        wcag:           null
      }));
    }
  }
}

/**
 * Checks HSTS max-age and includeSubDomains directives.
 */
function checkHstsStrength(findings, hstsValue) {
  const maxAgeMatch = hstsValue.match(/max-age=(\d+)/i);
  const maxAge      = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 0;

  if (maxAge < 31_536_000) {
    findings.push(createFinding({
      id:             'devtools-hsts-max-age-too-low',
      runner:         RUNNER_NAME,
      category:       CATEGORY.SECURITY,
      severity:       SEVERITY.MEDIUM,
      title:          `HSTS max-age is too low (${maxAge.toLocaleString()}s — recommended: 31,536,000s)`,
      detail:         'A short max-age means browsers stop enforcing HTTPS quickly after the last visit. HSTS preloading requires a minimum of 1 year.',
      evidence:       `Strict-Transport-Security: ${hstsValue}`,
      recommendation: 'Set: Strict-Transport-Security: max-age=31536000; includeSubDomains; preload',
      owasp:          owaspCode('ssl.hsts-max-age-too-low'),
      wcag:           null
    }));
  }

  if (!hstsValue.toLowerCase().includes('includesubdomains')) {
    findings.push(createFinding({
      id:             'devtools-hsts-missing-includesubdomains',
      runner:         RUNNER_NAME,
      category:       CATEGORY.SECURITY,
      severity:       SEVERITY.LOW,
      title:          'HSTS header is missing the includeSubDomains directive',
      detail:         'Without includeSubDomains, subdomains are not covered by HSTS and could be exploited to downgrade connections to the main domain via cookies.',
      evidence:       `Strict-Transport-Security: ${hstsValue}`,
      recommendation: 'Add includeSubDomains to the HSTS header.',
      owasp:          owaspCode('ssl.hsts-no-includesubdomains'),
      wcag:           null
    }));
  }
}

/**
 * Generates findings for HTTP 4xx and 5xx responses from network log.
 */
function generateNetworkErrorFindings(findings, networkErrors) {
  if (networkErrors.length === 0) return;

  const errors5xx = networkErrors.filter(e => e.status >= 500);
  const errors4xx = networkErrors.filter(e => e.status >= 400 && e.status < 500);

  if (errors5xx.length > 0) {
    findings.push(createFinding({
      id:             'devtools-network-5xx-errors',
      runner:         RUNNER_NAME,
      category:       CATEGORY.FUNCTIONAL,
      severity:       SEVERITY.HIGH,
      title:          `${errors5xx.length} HTTP 5xx server error(s) detected during page load`,
      detail:         'Server errors during page load indicate broken functionality. These directly impact user experience and can silently break cart, checkout, or account operations.',
      evidence:       errors5xx.map(e => `HTTP ${e.status} ${e.method} ${e.url}`).join('\n'),
      recommendation: 'Investigate each failing endpoint in server logs. Find the stack trace and fix the underlying handler.',
      owasp:          null,
      wcag:           null
    }));
  }

  if (errors4xx.length > 0) {
    // Filter out expected 4xx (favicon, tracking pixels, etc.)
    const meaningful4xx = errors4xx.filter(e =>
      !e.url.includes('favicon') && !e.url.includes('beacon') && !e.url.includes('ping')
    );
    if (meaningful4xx.length > 0) {
      findings.push(createFinding({
        id:             'devtools-network-4xx-errors',
        runner:         RUNNER_NAME,
        category:       CATEGORY.FUNCTIONAL,
        severity:       SEVERITY.MEDIUM,
        title:          `${meaningful4xx.length} HTTP 4xx error(s) detected during page load`,
        detail:         'Client errors typically indicate broken resource references — missing scripts, stylesheets, API endpoints, or images.',
        evidence:       meaningful4xx.map(e => `HTTP ${e.status} ${e.method} ${e.url}`).join('\n'),
        recommendation: 'Review each 4xx URL and either fix the broken reference or remove it from the page.',
        owasp:          null,
        wcag:           null
      }));
    }
  }
}

/**
 * Audits cookies for missing security flags on sensitive cookies.
 */
function generateCookieFindings(findings, cookies, hostname, mode) {
  const siteCookies = cookies.filter(c =>
    c.domain === hostname || c.domain === `.${hostname}` ||
    hostname.endsWith(c.domain.replace(/^\./, ''))
  );

  const missing = { httpOnly: [], secure: [], sameSite: [] };

  for (const cookie of siteCookies) {
    const isSensitive = SENSITIVE_COOKIE_PATTERNS.some(p => p.test(cookie.name));
    if (!isSensitive) continue;

    if (!cookie.httpOnly) missing.httpOnly.push(cookie.name);
    if (!cookie.secure)   missing.secure.push(cookie.name);
    if (!cookie.sameSite || cookie.sameSite === 'None') missing.sameSite.push(cookie.name);
  }

  if (missing.httpOnly.length > 0) {
    findings.push(createFinding({
      id:             `devtools-${mode}-cookies-missing-httponly`,
      runner:         RUNNER_NAME,
      category:       CATEGORY.SECURITY,
      severity:       SEVERITY.HIGH,
      title:          `${missing.httpOnly.length} sensitive cookie(s) missing HttpOnly flag`,
      detail:         'Cookies without HttpOnly can be read by JavaScript. If the site has an XSS vulnerability (e.g., from a compromised script), attackers can steal session tokens and hijack user accounts.',
      evidence:       `Cookies without HttpOnly: ${missing.httpOnly.join(', ')}`,
      recommendation: 'Set the HttpOnly flag on all session and authentication cookies.',
      owasp:          owaspCode('security.cookie-httponly-missing'),
      wcag:           null
    }));
  }

  if (missing.secure.length > 0) {
    findings.push(createFinding({
      id:             `devtools-${mode}-cookies-missing-secure`,
      runner:         RUNNER_NAME,
      category:       CATEGORY.SECURITY,
      severity:       SEVERITY.HIGH,
      title:          `${missing.secure.length} sensitive cookie(s) missing Secure flag`,
      detail:         'Cookies without the Secure flag can be transmitted over plain HTTP, exposing session tokens to network interception.',
      evidence:       `Cookies without Secure: ${missing.secure.join(', ')}`,
      recommendation: 'Add the Secure flag to all authentication and session cookies.',
      owasp:          owaspCode('security.cookie-secure-missing'),
      wcag:           null
    }));
  }

  if (missing.sameSite.length > 0) {
    findings.push(createFinding({
      id:             `devtools-${mode}-cookies-missing-samesite`,
      runner:         RUNNER_NAME,
      category:       CATEGORY.SECURITY,
      severity:       SEVERITY.MEDIUM,
      title:          `${missing.sameSite.length} sensitive cookie(s) missing SameSite attribute`,
      detail:         'Without SameSite, cookies are included in cross-site requests, enabling Cross-Site Request Forgery (CSRF) attacks.',
      evidence:       `Cookies without SameSite: ${missing.sameSite.join(', ')}`,
      recommendation: 'Set SameSite=Lax or SameSite=Strict on all session cookies.',
      owasp:          owaspCode('security.cookie-samesite-missing'),
      wcag:           null
    }));
  }
}

/**
 * Detects JWT tokens in cookie values.
 * A JWT starts with "eyJ" (base64url-encoded JSON object opening brace).
 *
 * @param {Object[]} cookies
 * @returns {Object[]} Detected JWTs with decoded headers
 */
function detectJwts(cookies) {
  const jwts = [];
  for (const cookie of cookies) {
    if (typeof cookie.value !== 'string') continue;
    if (!cookie.value.startsWith('eyJ'))  continue;

    const parts = cookie.value.split('.');
    if (parts.length !== 3) continue;

    try {
      const pad    = s => s + '='.repeat((4 - s.length % 4) % 4);
      const header = JSON.parse(Buffer.from(pad(parts[0]), 'base64').toString('utf8'));
      jwts.push({
        cookieName: cookie.name,
        header,
        preview:    cookie.value.slice(0, 50) + '...',
        error:      null
      });
    } catch (err) {
      jwts.push({ cookieName: cookie.name, header: null, preview: null, error: err.message });
    }
  }
  return jwts;
}

/**
 * Generates findings from JWT header inspection.
 * Flags dangerous algorithms and unsigned tokens.
 */
function generateJwtFindings(findings, jwt, mode) {
  if (jwt.error || !jwt.header) return;

  const alg = (jwt.header.alg ?? '').toLowerCase();

  if (alg === 'none') {
    findings.push(createFinding({
      id:             `devtools-${mode}-jwt-alg-none-${jwt.cookieName}`,
      runner:         RUNNER_NAME,
      category:       CATEGORY.SECURITY,
      severity:       SEVERITY.CRITICAL,
      title:          `JWT in cookie "${jwt.cookieName}" uses algorithm "none" — token is unsigned`,
      detail:         'A JWT with alg:none has no cryptographic signature. An attacker can forge an arbitrary token (e.g., claiming to be an admin) simply by encoding JSON and submitting it.',
      evidence:       `Cookie: ${jwt.cookieName} | alg: ${jwt.header.alg} | typ: ${jwt.header.typ ?? 'N/A'}`,
      recommendation: 'Reject JWTs with alg:none on the server. Use RS256 or ES256 (asymmetric) for token verification.',
      owasp:          owaspCode('security.jwt-alg-none'),
      wcag:           null
    }));
  }
  // Note: HS256 is acceptable but worth recording in metrics for context
}
