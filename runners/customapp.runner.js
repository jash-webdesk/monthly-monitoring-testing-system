import { launchChromium } from '../lib/browser.js';
import { createFinding, createRunnerResult, SEVERITY, CATEGORY } from '../lib/result.js';
import { logger } from '../lib/logger.js';
import { runSsl } from './ssl.runner.js';
import { runDns } from './dns.runner.js';
import { performLogin } from './devtools.runner.js';
import { getArchivePath } from '../lib/archive.js';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RUNNER_NAME = 'customapp';
const HEALTH_TIMEOUT_MS = 15_000;
const NAV_TIMEOUT_MS = 45_000;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Naive eTLD+1 comparison (last two DNS labels) — good enough here since none of
 * this system's actual hostnames use multi-part public suffixes (.co.uk etc).
 * Used to tell "client-owned subdomain" (app.genpet.org — client controls DNS for
 * genpet.org) apart from "subdomain of a shared hosting platform's domain"
 * (pcx-xxxx.herokuapp.com — herokuapp.com is Heroku's domain, the client cannot
 * add DNS records there under any circumstances).
 *
 * @param {string} hostA
 * @param {string} hostB
 * @returns {boolean}
 */
function sharesRegistrableDomain(hostA, hostB) {
  const rootOf = (h) => h.split('.').slice(-2).join('.').toLowerCase();
  return rootOf(hostA) === rootOf(hostB);
}

/**
 * Monitors a client's custom backend application (e.g. genpet.org's companion app
 * at app.genpet.org). Only runs when config/sites.json defines `customApp` for the
 * site being audited — every other site is a complete no-op via the caller's guard.
 *
 * SAFETY CONTRACT — Blueprint Section 19.3 (Production Safety):
 * This runner audits LIVE production data with no sandbox/test account available.
 * It must never create, modify, or delete anything in the target application.
 *
 * Steps implemented here:
 *   1. Reachability / response-time health check against the app's root URL (unauthenticated)
 *   2. SSL certificate check on the app's own hostname (reuses runSsl — generic/safe)
 *   3. DNS record check on the app's own hostname (reuses runDns — generic/safe)
 *   4. Authenticated login + curated navigation pass — ONLY runs once credentials are
 *      configured AND config.customApp.safeNavTargets is a non-empty, human-approved
 *      list (see discoveryApprovedBy/discoveryApprovedAt in config/sites.json). Until
 *      both conditions hold, this runner performs the unauthenticated checks above
 *      only, and emits an informational finding explaining what was skipped and why.
 *
 * The navigation pass is structurally restricted to read-only actions:
 *   - The ONLY page.click() in this entire file is the login submit button.
 *   - Every safeNavTargets visit is page.goto() only — never a click, never a form fill.
 *   - Every HTTP request observed during the nav pass is checked via CDP; any
 *     POST/PUT/PATCH/DELETE after login is treated as a CRITICAL finding and aborts
 *     the remaining nav pass — see WRITE_METHODS below.
 *
 * @param {Object} siteConfig - Full site config object from config/sites.json (must include .customApp)
 * @param {string} hostname   - Primary site hostname (e.g. "genpet.org") — used for logging/attribution and archive path
 * @param {string|null} [month] - YYYY-MM, used for the nav pass's screenshot archive path
 * @returns {Promise<Object>} Runner result envelope
 */
export async function runCustomApp(siteConfig, hostname, month = null) {
  logger.runnerStart(RUNNER_NAME);

  const customApp = siteConfig?.customApp;
  if (!customApp?.enabled || !customApp?.url) {
    // Defense in depth — monitor.js already gates on this before calling in, but this
    // function must never assume the caller checked correctly.
    logger.info('  Custom app not configured for this site — skipping.');
    return createRunnerResult(RUNNER_NAME, siteConfig?.hostname ?? hostname, [], { skipped: true });
  }

  const findings = [];
  const metrics = {
    appUrl:                customApp.url,
    appHostname:           customApp.hostname ?? null,
    health:                { reachable: false, status: null, responseTimeMs: null },
    ssl:                   null,
    dns:                   null,
    credentialsConfigured: false,
    navPassRan:            false,
    writeRequestsDetected: 0
  };

  // ── Credential / approved-target status (informational — no login performed here) ──
  const usernameEnvVar = customApp.auth?.usernameEnvVar;
  const passwordEnvVar = customApp.auth?.passwordEnvVar;
  const username = usernameEnvVar ? process.env[usernameEnvVar] : null;
  const password = passwordEnvVar ? process.env[passwordEnvVar] : null;
  metrics.credentialsConfigured = !!(username && password);

  if (!metrics.credentialsConfigured) {
    findings.push(createFinding({
      id:             'customapp-credentials-not-configured',
      runner:         RUNNER_NAME,
      category:       CATEGORY.CUSTOM_APP,
      severity:       SEVERITY.INFO,
      title:          'Custom app credentials not configured — health check only',
      detail:         `No credentials found in environment for this custom app. Only unauthenticated reachability, SSL, and DNS checks were performed this run — authenticated navigation testing was skipped.`,
      evidence:       `Environment variables checked: ${usernameEnvVar ?? 'n/a'}, ${passwordEnvVar ?? 'n/a'}`,
      recommendation: `Add ${usernameEnvVar ?? 'the configured username env var'} and ${passwordEnvVar ?? 'the configured password env var'} to .env to enable authenticated checks.`
    }));
  } else if (!customApp.safeNavTargets || customApp.safeNavTargets.length === 0) {
    findings.push(createFinding({
      id:             'customapp-nav-targets-not-approved',
      runner:         RUNNER_NAME,
      category:       CATEGORY.CUSTOM_APP,
      severity:       SEVERITY.INFO,
      title:          'No approved navigation targets configured — health check only',
      detail:         'Credentials are configured, but no safe navigation targets have been reviewed and approved yet. Authenticated navigation testing was skipped this run.',
      evidence:       'customApp.safeNavTargets is empty',
      recommendation: 'Complete the supervised discovery pass to catalog and approve a curated list of read-only pages before enabling navigation testing.'
    }));
  } else {
    try {
      const navResult = await runNavPass(customApp, username, password, hostname, month);
      metrics.navPassRan = true;
      metrics.writeRequestsDetected = navResult.writeRequestsDetected;
      metrics.navPages = navResult.pageResults;
      findings.push(...navResult.findings);
    } catch (err) {
      logger.warn(`  Custom app navigation pass failed: ${err.message}`);
      findings.push(createFinding({
        id:             'customapp-nav-pass-failed',
        runner:         RUNNER_NAME,
        category:       CATEGORY.CUSTOM_APP,
        severity:       SEVERITY.MEDIUM,
        title:          'Authenticated navigation pass failed to complete',
        detail:         'The automated login and navigation check could not complete. This may mean the login form changed, credentials are stale, or the app was unreachable during the authenticated pass.',
        evidence:       `Error: ${err.message}`,
        recommendation: 'Review the login mechanics in config.customApp.auth — the login page markup may have changed since the last discovery pass.'
      }));
    }
  }

  // ── Health / reachability check (unauthenticated) ──────────────────
  try {
    const start = Date.now();
    const res = await fetch(customApp.url, {
      method:   'GET',
      redirect: 'follow',
      signal:   AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    const elapsed = Date.now() - start;
    metrics.health.status       = res.status;
    metrics.health.responseTimeMs = elapsed;
    metrics.health.reachable    = res.status >= 200 && res.status < 400;

    if (!metrics.health.reachable) {
      findings.push(createFinding({
        id:             'customapp-unreachable',
        runner:         RUNNER_NAME,
        category:       CATEGORY.CUSTOM_APP,
        severity:       SEVERITY.CRITICAL,
        title:          `Custom app returned an error status (${res.status})`,
        detail:         `The companion application at ${customApp.url} did not return a healthy response. This may indicate the app is down or misconfigured.`,
        evidence:       `HTTP ${res.status} from ${customApp.url}`,
        recommendation: 'Check the custom app hosting/deployment status immediately.'
      }));
    }
    // NOTE: deliberately not flagging slow single-sample response times as a finding.
    // A one-off health-check request can catch a platform cold-start (e.g. a Heroku
    // dyno waking from idle) that doesn't reflect real usage — response time is still
    // recorded in metrics.health.responseTimeMs for trend visibility, just not treated
    // as an actionable finding off a single sample.
  } catch (err) {
    metrics.health.reachable = false;
    findings.push(createFinding({
      id:             'customapp-connection-failed',
      runner:         RUNNER_NAME,
      category:       CATEGORY.CUSTOM_APP,
      severity:       SEVERITY.CRITICAL,
      title:          'Custom app connection failed',
      detail:         `An automated connection attempt to ${customApp.url} failed completely.`,
      evidence:       `Connection error: ${err.message}`,
      recommendation: 'Check the custom app hosting provider and DNS configuration immediately.'
    }));
  }

  // ── SSL check on the app's own hostname (reuses the existing generic runner) ──
  try {
    const sslResult = await runSsl(customApp.url);
    metrics.ssl = sslResult.metrics;
    for (const f of sslResult.findings) {
      // Prefixed so these never collide with the primary domain's own SSL finding ids
      // in the same site's raw.json / month-over-month diff.
      findings.push({ ...f, id: `app-${f.id}` });
    }
  } catch (err) {
    logger.warn(`  Custom app SSL check failed: ${err.message}`);
  }

  // ── DNS check on the app's own hostname (reuses the existing generic runner) ──
  //
  // runDns() was built for a primary storefront domain that sends/receives customer
  // email — several of its generic findings don't apply to an admin-only backend
  // subdomain with no mail-sending purpose, and re-emitting them as-is would be
  // false positives:
  //   - Missing MX records is EXPECTED here (this subdomain was never meant to
  //     receive email) — not a finding.
  //   - Missing DMARC is a false positive: DMARC is NOT domain-exact like SPF — a
  //     parent domain's record covers subdomains automatically unless the parent
  //     sets an explicit `sp=` tag or the subdomain publishes its own. Flagging the
  //     subdomain as "unprotected" when it's inheriting the parent's policy is wrong.
  //   - Missing DKIM is inapplicable — DKIM only matters for a domain that actively
  //     signs outgoing mail, which a subdomain with no MX records does not do.
  //   - Missing SPF IS a real, independent gap — unlike DMARC, SPF has no
  //     parent-domain fallback (a subdomain with no SPF record returns a bare
  //     "none" result, it does not check the parent). But since this subdomain
  //     doesn't send mail, the correct recommendation is a null SPF record
  //     (`v=spf1 -all`) that explicitly declares "no legitimate mail comes from
  //     here" — not generic mail-provider setup guidance, which would be misleading.
  //
  // All of the above assumes the client actually controls DNS for the custom app's
  // hostname. That's true for a subdomain of the client's own domain (app.genpet.org
  // under genpet.org), but NOT true for an app hosted on a shared platform's domain
  // (e.g. pcx-xxxx.herokuapp.com — herokuapp.com belongs to Heroku; the client has no
  // path to add a DNS/SPF record there no matter what we recommend). Running the DNS
  // check in that case would generate advice the client structurally cannot act on —
  // skip it entirely and say why, rather than emit an unactionable "add a DNS record"
  // finding for a domain they don't own.
  const clientControlsDns = customApp.hostname && sharesRegistrableDomain(customApp.hostname, hostname);

  if (customApp.hostname && !clientControlsDns) {
    findings.push(createFinding({
      id:             'customapp-dns-not-client-controlled',
      runner:         RUNNER_NAME,
      category:       CATEGORY.CUSTOM_APP,
      severity:       SEVERITY.INFO,
      title:          'DNS check skipped — hostname is on a shared hosting platform domain',
      detail:         `${customApp.hostname} is a subdomain of a third-party hosting platform's own domain, not a domain the client controls DNS for. SPF/DMARC/DKIM recommendations would not be actionable, so the DNS check was skipped for this app.`,
      evidence:       `Custom app hostname "${customApp.hostname}" does not share a registrable domain with the primary site "${hostname}"`,
      recommendation: 'No action needed — this is expected for apps hosted on a shared platform domain (e.g. Heroku\'s default *.herokuapp.com hostname). If a custom domain is later mapped to this app, re-enable DNS checks against that domain instead.'
    }));
  } else if (customApp.hostname) {
    try {
      const dnsResult = await runDns(customApp.hostname);
      metrics.dns = dnsResult.metrics;

      const NOT_APPLICABLE_FOR_NON_SENDING_SUBDOMAIN = new Set([
        'dns-no-mx-record',
        'dns-no-dmarc-record',
        'dns-no-dkim-record'
      ]);

      for (const f of dnsResult.findings) {
        if (NOT_APPLICABLE_FOR_NON_SENDING_SUBDOMAIN.has(f.id)) continue;

        if (f.id === 'dns-no-spf-record') {
          findings.push(createFinding({
            id:             `app-${f.id}`,
            runner:         RUNNER_NAME,
            category:       CATEGORY.SECURITY,
            severity:       SEVERITY.MEDIUM,
            title:          'No SPF record found on custom app subdomain',
            detail:         `${customApp.hostname} does not send email, but has no SPF record either. SPF does not inherit from the parent domain — without an explicit record, an attacker could still spoof "@${customApp.hostname}" addresses in phishing attempts. Since this subdomain never legitimately sends mail, a null SPF record is the correct fix rather than mail-provider setup.`,
            evidence:       f.evidence,
            recommendation: `Add a null SPF record to explicitly declare this subdomain never sends mail: "v=spf1 -all"`,
            owasp:          f.owasp,
            wcag:           null
          }));
          continue;
        }

        findings.push({ ...f, id: `app-${f.id}` });
      }
    } catch (err) {
      logger.warn(`  Custom app DNS check failed: ${err.message}`);
    }
  }

  const result = createRunnerResult(RUNNER_NAME, customApp.url, findings, metrics);
  logger.runnerDone(RUNNER_NAME, findings.length);
  return result;
}

// ── Authenticated navigation pass ───────────────────────────────────

/**
 * Logs into the custom app and visits ONLY the human-approved safeNavTargets list,
 * capturing console errors, 4xx/5xx network responses, and a screenshot per page.
 *
 * Read-only by construction, not just by intent:
 *   - The only page.click() call anywhere in this function is the login submit button.
 *   - Every safeNavTargets entry is visited via page.goto() only.
 *   - Every HTTP request made AFTER login is inspected via CDP; the first
 *     POST/PUT/PATCH/DELETE observed is treated as a critical safety violation —
 *     it aborts the remaining targets immediately and is reported as a CRITICAL
 *     finding, since it means something unexpected wrote data during a run that
 *     is supposed to be strictly read-only.
 *
 * @param {Object} customApp - customApp config block (must have .auth and .safeNavTargets)
 * @param {string} username
 * @param {string} password
 * @param {string} hostname  - primary site hostname, used for the screenshot archive path
 * @param {string|null} month
 * @returns {Promise<{findings: Object[], writeRequestsDetected: number, pageResults: Object[]}>}
 */
async function runNavPass(customApp, username, password, hostname, month) {
  const findings = [];
  const pageResults = [];
  const writeRequests = [];

  const auth = customApp.auth ?? {};
  if (!auth.loginUrl || !auth.usernameSelector || !auth.passwordSelector || !auth.submitSelector) {
    findings.push(createFinding({
      id:             'customapp-login-mechanics-incomplete',
      runner:         RUNNER_NAME,
      category:       CATEGORY.CUSTOM_APP,
      severity:       SEVERITY.MEDIUM,
      title:          'Navigation pass skipped — login mechanics not fully configured',
      detail:         'customApp.auth is missing loginUrl, usernameSelector, passwordSelector, or submitSelector. These must be discovered and set before the authenticated navigation pass can run.',
      evidence:       `auth config: ${JSON.stringify({ loginUrl: auth.loginUrl, usernameSelector: auth.usernameSelector, passwordSelector: auth.passwordSelector, submitSelector: auth.submitSelector })}`,
      recommendation: 'Complete login discovery and populate all four fields in config.customApp.auth.'
    }));
    return { findings, writeRequestsDetected: 0, pageResults };
  }

  // Session persistence: avoid hitting the login form on every single run. Saved
  // cookies live outside results/ (which may be shared with the client) in a
  // gitignored .cache/ directory, and are only ever reused after we've confirmed
  // they're still valid (see the reusedSession verification below) — if expired,
  // we transparently fall back to a fresh login and re-save.
  const sessionDir = resolve(process.cwd(), '.cache', 'customapp-sessions');
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, `${customApp.hostname}.json`);
  const hasSavedSession = existsSync(sessionPath);

  let browser = null;
  try {
    browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; MonthlyMonitor/1.0; +https://webdesksolution.com/)',
      ignoreHTTPSErrors: true,
      ...(hasSavedSession ? { storageState: sessionPath } : {})
    });
    const page = await context.newPage();

    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Console.enable');

    // Only requests observed AFTER login/session-restore count toward the write-method
    // guardrail — the login POST itself is expected and must not trip this check.
    let trackWrites = false;
    let currentPageConsole = [];
    let currentPageNetworkErrors = [];

    cdp.on('Network.requestWillBeSent', (event) => {
      if (trackWrites && WRITE_METHODS.has(event.request.method)) {
        writeRequests.push({ method: event.request.method, url: event.request.url });
      }
    });
    cdp.on('Network.responseReceived', (event) => {
      if (event.response.status >= 400) {
        currentPageNetworkErrors.push({ url: event.response.url, status: event.response.status });
      }
    });
    cdp.on('Console.messageAdded', (event) => {
      if (event.message.level === 'error') {
        currentPageConsole.push(event.message.text);
      }
    });

    const loginPath = new URL(auth.loginUrl).pathname;
    let sessionValid = false;

    if (hasSavedSession) {
      logger.info('  Reusing saved session — verifying it is still valid...');
      trackWrites = true; // no login form involved on this path — everything is already "post-auth"
      await page.goto(customApp.url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS }).catch(() => {});
      sessionValid = new URL(page.url()).pathname !== loginPath;
      if (sessionValid) {
        logger.success('  Saved session still valid — skipped login form');
      } else {
        logger.warn('  Saved session expired — falling back to fresh login');
        trackWrites = false; // reset — the fresh login path below re-arms this after its own POST
        writeRequests.length = 0; // the expired-session probe isn't a real write-detection signal
      }
    }

    if (!sessionValid) {
      logger.info(`  Logging into custom app at ${auth.loginUrl}...`);
      await performLogin(page, {
        loginUrl:         auth.loginUrl,
        usernameSelector: auth.usernameSelector,
        passwordSelector: auth.passwordSelector,
        submitSelector:   auth.submitSelector,
        username,
        password
      }, customApp.url);

      // Diagnostic screenshot regardless of outcome — helps distinguish "form never
      // rendered" (bot detection / WAF challenge) from "form rendered but selectors
      // were wrong" without needing to re-run interactively.
      try {
        const diagDir = getArchivePath(hostname, month);
        mkdirSync(diagDir, { recursive: true });
        await page.screenshot({ path: join(diagDir, 'screenshot_customapp_login-attempt.png'), fullPage: false });
      } catch { /* best-effort diagnostic only */ }

      trackWrites = true; // login's own POST is complete — everything from here must be read-only
    }

    // performLogin degrades gracefully on failure (it never throws — see its own
    // docstring), so a failed login would otherwise silently fall through to visiting
    // safeNavTargets unauthenticated and reporting a false "clean" result. Explicitly
    // verify we actually left the login page before trusting anything that follows.
    const currentPath = new URL(page.url()).pathname;
    if (currentPath === loginPath) {
      findings.push(createFinding({
        id:             'customapp-login-failed',
        runner:         RUNNER_NAME,
        category:       CATEGORY.CUSTOM_APP,
        severity:       SEVERITY.HIGH,
        title:          'Authenticated navigation pass skipped — login did not succeed',
        detail:         'The login attempt did not redirect away from the login page, meaning authentication failed. This may mean the stored credentials are stale/incorrect, the login form markup changed since the last discovery pass, or the app is rejecting automated logins.',
        evidence:       `Still on ${page.url()} after attempting login at ${auth.loginUrl}`,
        recommendation: 'Verify the credentials in .env are still correct, and manually confirm the login form has not changed since the last discovery pass.'
      }));
      await context.close();
      return { findings, writeRequestsDetected: 0, pageResults };
    }
    logger.success('  Login confirmed — proceeding with navigation pass');

    if (!sessionValid) {
      try {
        await context.storageState({ path: sessionPath });
        logger.info('  Session saved — future runs will skip the login form until it expires');
      } catch (err) {
        logger.warn(`  Failed to save session for reuse: ${err.message}`);
      }
    }

    const archiveDir = getArchivePath(hostname, month);
    mkdirSync(archiveDir, { recursive: true });

    for (const target of (customApp.safeNavTargets ?? [])) {
      if (writeRequests.length > 0) break; // safety trip — stop visiting further pages immediately

      currentPageConsole = [];
      currentPageNetworkErrors = [];
      const slug = target.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      try {
        await page.goto(target.url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
      } catch (navErr) {
        logger.warn(`  Nav to "${target.label}" timed out waiting for networkidle — continuing: ${navErr.message}`);
      }

      const screenshotPath = join(archiveDir, `screenshot_customapp_${slug}.png`);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
      } catch (ssErr) {
        logger.warn(`  Screenshot failed for "${target.label}": ${ssErr.message}`);
      }

      if (writeRequests.length > 0) {
        // A write request happened while loading/settling this page — stop immediately,
        // do not proceed to score this page's console/network state, report and bail.
        break;
      }

      pageResults.push({
        label:         target.label,
        url:           target.url,
        consoleErrors: currentPageConsole.length,
        networkErrors: currentPageNetworkErrors.length
      });

      if (currentPageConsole.length > 0) {
        findings.push(createFinding({
          id:             `customapp-console-errors-${slug}`,
          runner:         RUNNER_NAME,
          category:       CATEGORY.CUSTOM_APP,
          severity:       SEVERITY.LOW,
          title:          `${currentPageConsole.length} JavaScript console error(s) on "${target.label}"`,
          detail:         'Console errors indicate broken JavaScript that may silently break functionality on this page.',
          evidence:       currentPageConsole.slice(0, 5).join('\n'),
          recommendation: 'Review and fix the console errors on this page.'
        }));
      }
      if (currentPageNetworkErrors.length > 0) {
        findings.push(createFinding({
          id:             `customapp-network-errors-${slug}`,
          runner:         RUNNER_NAME,
          category:       CATEGORY.CUSTOM_APP,
          severity:       SEVERITY.MEDIUM,
          title:          `${currentPageNetworkErrors.length} network error(s) (4xx/5xx) on "${target.label}"`,
          detail:         'One or more requests failed while loading this page.',
          evidence:       currentPageNetworkErrors.slice(0, 5).map(e => `${e.status} ${e.url}`).join('\n'),
          recommendation: 'Check the custom app backend logs for the failing endpoint(s) listed in evidence.'
        }));
      }
    }

    if (writeRequests.length > 0) {
      findings.push(createFinding({
        id:             'customapp-unexpected-write-request',
        runner:         RUNNER_NAME,
        category:       CATEGORY.CUSTOM_APP,
        severity:       SEVERITY.CRITICAL,
        title:          'Unexpected write request detected during read-only navigation pass',
        detail:         'The navigation pass only ever calls page.goto() on pre-approved URLs and never submits any form, yet a POST/PUT/PATCH/DELETE request was observed after login. This should be investigated immediately — it means the target application itself is issuing write requests as a side effect of simply loading a page (e.g. an auto-save, a tracking beacon that mutates state, or a misconfigured page). The remaining navigation targets for this run were skipped as a precaution.',
        evidence:       writeRequests.map(w => `${w.method} ${w.url}`).join('\n'),
        recommendation: 'Investigate why loading an approved read-only page triggers a write request. Do not add further nav targets until this is understood.'
      }));
    }

    await context.close();
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }

  return { findings, writeRequestsDetected: writeRequests.length, pageResults };
}
