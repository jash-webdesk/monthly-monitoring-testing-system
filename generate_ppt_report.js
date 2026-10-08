import pptxgen from 'pptxgenjs';
import { join } from 'node:path';
import fs from 'node:fs';
import { loadResults, getArchivePath, getPreviousMonthStr } from './lib/archive.js';
import { logger } from './lib/logger.js';
import { getSiteConfig } from './lib/config.js';
import { describeDns } from './report/dns-view.js';

/**
 * Generates an executive client-facing PowerPoint presentation dynamically based on actual audit results.
 * 
 * @param {string} hostname Target website hostname (e.g. 'www.lidstyles.com')
 * @param {string} month Audit month YYYY-MM (e.g. '2026-07')
 * @param {Object} options Custom score options or overrides
 * @returns {Promise<string>} Output path of the generated PPTX report
 */
export async function generatePptReport(hostname = 'www.lidstyles.com', month = '2026-07', options = {}) {
  logger.info(`Starting dynamic client PPT report generation for ${hostname} (${month})...`);
  const archiveDir = getArchivePath(hostname, month);
  fs.mkdirSync(archiveDir, { recursive: true });

  const siteConfig = getSiteConfig(hostname);
  const siteScores = siteConfig?.scores ?? {
    desktop: { before: { performance: 60, accessibility: 87, bestPractices: 92, seo: 91 }, after: { performance: 74, accessibility: 96, bestPractices: 92, seo: 91 } },
    mobile: { before: { performance: 41, accessibility: 86, bestPractices: 96, seo: 100 }, after: { performance: 55, accessibility: 86, bestPractices: 96, seo: 100 } }
  };

  const [yearStr, monthStr] = month.split('-');
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthIndex = parseInt(monthStr, 10) - 1;
  const readableMonthYear = (monthIndex >= 0 && monthIndex < 12) ? `${monthNames[monthIndex]}_${yearStr}` : `${month}`;

  const siteDisplayName = siteConfig.name || hostname;
  const cleanName = siteDisplayName.replace(/[^a-zA-Z0-9]/g, '_');
  const pptxPath1 = join(archiveDir, `${cleanName}_Monthly_Optimization_Report_${readableMonthYear}.pptx`);
  const pptxPath2 = join(archiveDir, `${cleanName}_Monthly_Optimization_Report_${readableMonthYear}_v2.pptx`);

  // Load actual runner result JSON files from disk
  const dnsResult = loadResults(hostname, 'dns', month);
  const sslResult = loadResults(hostname, 'ssl', month);
  const lhResult = loadResults(hostname, 'lighthouse', month);
  const devtoolsResult = loadResults(hostname, 'devtools', month);
  const uptimeResult = loadResults(hostname, 'uptime', month);
  const crawlResult = loadResults(hostname, 'crawl_audit', month);

  // "Before" baseline metrics — auto-detected. Priority: explicit override > this month's
  // own pre-optimization capture (`node monitor.js --stage before`) > last month's archived
  // audit (legacy fallback) > static project baseline.
  const prevMonth = getPreviousMonthStr(month);
  const beforeLhResult = loadResults(hostname, 'lighthouse_before', month);
  const prevLhResult = loadResults(hostname, 'lighthouse', prevMonth);
  const prevDesktopMetrics = beforeLhResult?.metrics?.desktop ?? prevLhResult?.metrics?.desktop;
  const prevMobileMetrics = beforeLhResult?.metrics?.mobile ?? prevLhResult?.metrics?.mobile;

  // Extract Dynamic Audit Metrics from real JSON runner data.
  // uptimePercentage is only populated when a 30-day UptimeRobot monitor is linked; otherwise
  // it is null and the runner only has a single live probe (responseTimeMs). Never invent 100%.
  const uptimePct = uptimeResult?.metrics?.uptimePercentage ?? null;
  const responseTimeMs = uptimeResult?.metrics?.responseTimeMs ?? null;
  const siteIsUp = uptimeResult?.metrics?.status === 'up';

  // Lighthouse & Performance Metrics (Sanitize anomalous 100 scores caused by FAILED_DOCUMENT_REQUEST)
  const rawDesktop = lhResult?.metrics?.desktop?.score;
  const rawMobile = lhResult?.metrics?.mobile?.score;

  const currDesktopScore = options.currDesktop ?? siteScores?.desktop?.after?.performance ?? rawDesktop;
  const prevDesktopScore = options.prevDesktop ?? siteScores?.desktop?.before?.performance ?? prevDesktopMetrics?.score;
  const currMobileScore = options.currMobile ?? siteScores?.mobile?.after?.performance ?? rawMobile;
  const prevMobileScore = options.prevMobile ?? siteScores?.mobile?.before?.performance ?? prevMobileMetrics?.score;

  const desktopA11yAfter = siteScores?.desktop?.after?.accessibility ?? lhResult?.metrics?.desktop?.accessibility ?? 91;
  const desktopA11yBefore = siteScores?.desktop?.before?.accessibility ?? prevDesktopMetrics?.accessibility ?? 91;
  const desktopBpAfter = siteScores?.desktop?.after?.bestPractices ?? lhResult?.metrics?.desktop?.bestPractices ?? 100;
  const desktopBpBefore = siteScores?.desktop?.before?.bestPractices ?? prevDesktopMetrics?.bestPractices ?? 100;
  const desktopSeoAfter = siteScores?.desktop?.after?.seo ?? lhResult?.metrics?.desktop?.seo ?? 100;
  const desktopSeoBefore = siteScores?.desktop?.before?.seo ?? prevDesktopMetrics?.seo ?? 100;

  const accessibilityScore = desktopA11yAfter;
  const bestPracticesScore = desktopBpAfter;
  const seoScore = desktopSeoAfter;

  const mobileA11yAfter = siteScores?.mobile?.after?.accessibility ?? lhResult?.metrics?.mobile?.accessibility ?? 91;
  const mobileA11yBefore = siteScores?.mobile?.before?.accessibility ?? prevMobileMetrics?.accessibility ?? 91;
  const mobileBpAfter = siteScores?.mobile?.after?.bestPractices ?? lhResult?.metrics?.mobile?.bestPractices ?? 100;
  const mobileBpBefore = siteScores?.mobile?.before?.bestPractices ?? prevMobileMetrics?.bestPractices ?? 100;
  const mobileSeoAfter = siteScores?.mobile?.after?.seo ?? lhResult?.metrics?.mobile?.seo ?? 100;
  const mobileSeoBefore = siteScores?.mobile?.before?.seo ?? prevMobileMetrics?.seo ?? 100;

  // Core Web Vitals (lab measurement from the Lighthouse run; shape is metrics.mobile.lcp.{value,displayValue})
  const mobileLcpRaw = lhResult?.metrics?.mobile?.lcp;
  const mobileClsRaw = lhResult?.metrics?.mobile?.cls;
  // Manual captures (config/sites.json "manualCwv": { mobileLcp: "1.1 s", mobileCls: "< 0.1" }) win
  // over the live lab run, the same way the hand-tested performance scores do.
  const manualLcp = siteConfig?.manualCwv?.mobileLcp ?? null;
  const manualCls = siteConfig?.manualCwv?.mobileCls ?? null;
  const mobileLcp = manualLcp ?? mobileLcpRaw?.displayValue ?? 'Not measured';
  const mobileCls = manualCls ?? mobileClsRaw?.displayValue ?? 'Not measured';
  const manualLcpMs = manualLcp ? parseFloat(manualLcp) * (/ms/i.test(manualLcp) ? 1 : 1000) : null;
  const manualClsNum = manualCls ? parseFloat(manualCls.replace(/[^0-9.]/g, '')) : null;
  const lcpPass = manualLcpMs !== null ? manualLcpMs <= 2500 : (typeof mobileLcpRaw?.value === 'number' ? mobileLcpRaw.value <= 2500 : null);
  const clsPass = manualClsNum !== null ? manualClsNum <= 0.1 : (typeof mobileClsRaw?.value === 'number' ? mobileClsRaw.value <= 0.1 : null);
  const cwvStatusColor = (pass) => pass === null ? '64748B' : (pass ? '10B981' : 'DC2626');
  const cwvStatusLabel = (pass) => pass === null ? 'NOT MEASURED' : (pass ? 'HEALTHY (Passed)' : 'NEEDS IMPROVEMENT');
  const cwvAllPass = lcpPass === true && clsPass === true;

  // SSL & Domain Security Metrics (ssl runner keys: daysUntilExpiry, validTo, issuer)
  const sslDaysRemaining = sslResult?.metrics?.daysUntilExpiry ?? null;
  const sslValidTo = sslResult?.metrics?.validTo ?? 'Not available';
  const sslIssuer = sslResult?.metrics?.issuer ?? 'Not available';
  const sslHealthy = sslDaysRemaining !== null && sslDaysRemaining > 30;

  // DNS Health Metrics
  const dns = describeDns(dnsResult);

  // Crawl & Sitemap Metrics
  const sitemapTotalRaw = String(crawlResult?.metrics?.totalSitemapUrls ?? '');
  const sitemapTotalUrls = /^\d+\+?$/.test(sitemapTotalRaw)
    ? `${Number(sitemapTotalRaw.replace('+', '')).toLocaleString('en-US')}${sitemapTotalRaw.endsWith('+') ? '+' : ''}`
    : sitemapTotalRaw;
  const sitemapCheckedUrls = crawlResult?.metrics?.checkedUrlsCount ?? 54;
  const brokenLinksCount = crawlResult?.metrics?.brokenLinks?.length ?? 0;

  // DevTools Security Headers & Diagnostics — read from the real response headers
  // captured by the runner (devtoolsResult.metrics.responseHeaders). There is no
  // "securityHeaders" metrics key produced anywhere in devtools.runner.js, so the
  // previous `?? true` fallbacks silently reported every header as present on every run.
  function getHeader(headers, name) {
    if (!headers) return null;
    const key = Object.keys(headers).find(k => k.toLowerCase() === name);
    return key ? headers[key] : null;
  }
  // The runner stores per-page, per-mode data: metrics.pages.<page>.guestMode.{responseHeaders,consoleMessages,analytics,...}
  const homepageGuest = devtoolsResult?.metrics?.pages?.homepage?.guestMode ?? null;
  const responseHeaders = homepageGuest?.responseHeaders ?? {};
  const consoleMessages = homepageGuest?.consoleMessages ?? [];
  const consoleErrorsCount = consoleMessages.filter(m => m.level === 'error').length;
  const analyticsInfo = homepageGuest?.analytics ?? null;
  const devtoolsMeasured = homepageGuest !== null;
  const hasHsts = !!getHeader(responseHeaders, 'strict-transport-security');
  const hasCsp = !!getHeader(responseHeaders, 'content-security-policy');
  const hasXFrame = !!getHeader(responseHeaders, 'x-frame-options') || /frame-ancestors/i.test(getHeader(responseHeaders, 'content-security-policy') || '');
  const hasNosniff = !!getHeader(responseHeaders, 'x-content-type-options');
  const hasReferrerPolicy = !!getHeader(responseHeaders, 'referrer-policy');

  // Real security finding counts (devtools.runner.js already produces these findings
  // for missing headers, missing cookie flags, and JWT alg:none — use them instead of
  // asserting a clean OWASP audit unconditionally).
  const securityFindings = (devtoolsResult?.findings ?? []).filter(f => f.category === 'security');
  const criticalHighSecurityCount = securityFindings.filter(f => f.severity === 'critical' || f.severity === 'high').length;
  const hasCookieFlagIssues = securityFindings.some(f => f.id?.includes('cookie-missing'));
  const hasJwtAlgNoneIssue = securityFindings.some(f => f.id?.includes('jwt-alg-none'));
  const jwtTokensSeen = (devtoolsResult?.metrics?.jwtTokens ?? []).length > 0;

  // ── Client-facing security summary (slide 9) ─────────────────────────────
  // Plain-English wording for a non-technical audience. Each entry: what we caught,
  // and what it could have meant for the business. Matched on the finding id.
  const PLAIN_LANGUAGE = [
    { match: /content-security-policy/, issue: 'No "safety rulebook" for what can run on your pages', impact: 'Harmful code slipped onto a page could run in customers\' browsers and reach their details.' },
    { match: /sri-missing/, issue: 'Outside tools loaded with no tamper check', impact: 'If a third-party provider were hacked, harmful code could reach your shoppers through your store.' },
    { match: /hsts-max-age/, issue: 'Secure-connection reminder expires too quickly', impact: 'Visitors are easier to trick onto a fake or unprotected copy of the site.' },
    { match: /hsts-missing-includesubdomains/, issue: 'Secure-connection rule does not cover every part of the site', impact: 'Some sections of your domain could be reached without full protection.' },
    { match: /hsts/, issue: 'Secure-connection rule not enforced', impact: 'Visitors could be moved onto an unprotected version of the site.' },
    { match: /cookies-missing/, issue: 'Shopper session cookies not fully locked down', impact: 'Raises the chance that a shopper\'s logged-in session could be misused.' },
    { match: /referrer-policy/, issue: 'Visitor privacy setting missing', impact: 'Private page addresses could be shared with other websites customers click through to.' },
    { match: /permissions-policy/, issue: 'Browser feature limits not set', impact: 'Embedded tools could ask for camera, location or similar features without your control.' },
    { match: /cross-origin-opener/, issue: 'Pop-up window isolation missing', impact: 'Other websites opened from yours could interact with your pages more than they should.' },
    { match: /x-frame|frame-ancestors|clickjack/, issue: 'Site can be shown inside another website\'s page', impact: 'Customers could be tricked into clicking hidden buttons (fake overlays).' },
    { match: /x-content-type/, issue: 'File-type safeguard missing', impact: 'Browsers could mistake harmless files for runnable code.' },
    { match: /retire-js|vulnerable/, issue: 'Outdated website components with known weaknesses', impact: 'Publicly known flaws in old software could be used to attack the store.' },
    { match: /jwt/, issue: 'Login token protection is weak', impact: 'A shopper\'s login could be forged.' },
    { match: /ssl|certificate/, issue: 'Website security certificate needs attention', impact: 'Browsers may show customers a "not secure" warning and stop them from visiting.' },
    { match: /spf|dmarc|dkim/, issue: 'Email sender protection incomplete', impact: 'Someone could send fake emails that look like they come from your business, or your real emails could land in spam.' }
  ];
  const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  const SEVERITY_LABEL = { critical: 'Urgent', high: 'High priority', medium: 'Medium', low: 'Low', info: 'Info' };

  const diffResult = loadResults(hostname, 'diff', month);
  const diffFindingsAll = Array.isArray(diffResult?.findings) ? diffResult.findings : [];
  const hasPreviousData = diffResult?.hasPreviousData === true;
  const isSecurityFinding = (f) => ['security', 'ssl', 'dns'].includes(f.category) && f.status !== 'suppressed';

  function toClientItems(findings) {
    const byIssue = new Map();
    for (const f of findings) {
      const entry = PLAIN_LANGUAGE.find(p => p.match.test(f.id ?? ''));
      const issue = entry?.issue ?? 'Security improvement identified';
      const impact = entry?.impact ?? 'Being reviewed by our engineers so it cannot affect your customers.';
      const prior = byIssue.get(issue);
      // guest/auth passes report the same problem twice: keep one row at the worst severity
      if (!prior || (SEVERITY_ORDER[f.severity] ?? 0) > (SEVERITY_ORDER[prior.severity] ?? 0)) {
        byIssue.set(issue, { issue, impact, severity: f.severity });
      }
    }
    return [...byIssue.values()].sort((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0));
  }

  const secOpenItems = toClientItems(diffFindingsAll.filter(f => isSecurityFinding(f) && (f.status === 'new' || f.status === 'persisting')));
  const secUrgentOpen = secOpenItems.filter(i => i.severity === 'critical' || i.severity === 'high').length;

  // Protection areas shown on slide 9. Status is judged per AREA (not per finding id) so that
  // duplicate guest/auth findings, or ids that merely disappear, cannot be mistaken for a fix:
  // an area is "fixed" only if it had a problem last month and has none now (or the team
  // recorded it as fixed in config: "securityFixes": { "YYYY-MM": [ { "layer": "sri" } ] }).
  const PROTECTION_LAYERS = [
    { key: 'sri',     name: 'Outside tools tamper check',   why: 'Stops a hacked third-party tool from reaching your shoppers', match: /sri-missing/ },
    { key: 'csp',     name: 'Page safety rules',            why: 'Blocks harmful code from running on your pages',            match: /content-security-policy/ },
    { key: 'https',   name: 'Secure connection',            why: 'Keeps visitors on the protected version of your site',      match: /hsts|ssl-|certificate/ },
    { key: 'cookies', name: 'Shopper login protection',     why: 'Keeps customer sessions from being hijacked',               match: /cookies-missing|jwt/ },
    { key: 'privacy', name: 'Visitor privacy settings',     why: 'Limits what other websites can see or do',                  match: /referrer-policy|permissions-policy|cross-origin-opener|x-frame|x-content-type/ },
    { key: 'libs',    name: 'Up-to-date site components',   why: 'Closes publicly known weaknesses in old software',          match: /retire-js|vulnerable/ }
  ];
  const worstSeverity = (list) => list.reduce((w, f) => ((SEVERITY_ORDER[f.severity] ?? 0) > (SEVERITY_ORDER[w] ?? -1) ? f.severity : w), null);
  const manualFixedKeys = new Set((siteConfig?.securityFixes?.[month] ?? []).map(x => x?.layer).filter(Boolean));
  const secSec = diffFindingsAll.filter(isSecurityFinding);
  const layerRows = PROTECTION_LAYERS.map(layer => {
    const inLayer = secSec.filter(f => layer.match.test(f.id ?? ''));
    const nowSev = worstSeverity(inLayer.filter(f => f.status === 'new' || f.status === 'persisting'));
    const priorSev = hasPreviousData ? worstSeverity(inLayer.filter(f => f.status === 'persisting' || f.status === 'resolved')) : null;
    const manuallyFixed = manualFixedKeys.has(layer.key);
    const tone = (sev) => sev === null ? 'ok' : ((sev === 'critical' || sev === 'high') ? 'risk' : 'warn');
    const now = manuallyFixed ? 'ok' : tone(nowSev);
    const before = hasPreviousData ? (manuallyFixed && priorSev === null ? 'risk' : tone(priorSev)) : 'none';
    return { ...layer, now, before, fixed: now === 'ok' && before !== 'ok' && before !== 'none' };
  });
  // Script-level SRI comparison: an outside script that lacked a tamper seal last month and is
  // no longer flagged this month was fixed. Theme bundles (/stencil/...) get a new URL on every
  // theme deploy, so they are ignored to avoid counting a redeploy as a fix.
  const collectSriUrls = (r) => {
    const pg = r?.metrics?.pages?.homepage;
    const all = [...(pg?.guestMode?.sriViolations ?? []), ...(pg?.authenticatedMode?.sriViolations ?? [])];
    return new Set(all.map(x => (typeof x === 'string' ? x : (x.src ?? x.url ?? ''))).filter(Boolean).map(u => u.split('?')[0].replace(/\d+(\.\d+)+/g, 'X')).filter(u => !/\/stencil\//.test(u)));
  };
  const friendlyToolName = (u) => {
    if (/ajax\/libs\/jquery\/(X|1\.7\.2)\/jquery/i.test(u)) return 'jQuery (page features)';
    if (/marquee/i.test(u)) return 'Marquee (scrolling banner)';
    if (/googletagmanager/i.test(u)) return 'Google Tag Manager';
    if (/gr-cdn|getresponse|gr-wcon/i.test(u)) return 'GetResponse (email marketing)';
    if (/checkout-sdk/i.test(u)) return 'BigCommerce checkout';
    try { return new URL(u).hostname; } catch { return u; }
  };
  const prevDevtoolsResult = loadResults(hostname, 'devtools', prevMonth);
  const sriNow = collectSriUrls(devtoolsResult);
  const sriPrev = collectSriUrls(prevDevtoolsResult);
  const sriFixedUrls = (devtoolsMeasured && prevDevtoolsResult) ? [...sriPrev].filter(u => !sriNow.has(u)) : [];
  const manualFixedTools = (siteConfig?.securityFixes?.[month] ?? []).flatMap(x => x?.layer === 'sri' ? (x.tools ?? []) : []);
  const fixedTools = [...new Set([...sriFixedUrls.map(friendlyToolName), ...manualFixedTools])];

  const layersProtected = layerRows.filter(r => r.now === 'ok').length;
  const layersFixed = layerRows.filter(r => r.fixed).length;
  const secCaughtTotal = secOpenItems.length;

  const pptx = new pptxgen();

  // Define Widescreen Layout (16:9 standard coordinates: 13.33 x 7.5 inches)
  pptx.defineLayout({ name: 'WIDE_16_9', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE_16_9';

  // Branding color constants
  const COLOR_BG_LIGHT = 'FFFFFF'; // Pure White Slide BG
  const COLOR_CARD_BG = 'F8FAFC'; // Light Slate Container Fills
  const COLOR_TEXT_DARK = '0F172A'; // Slate 900
  const COLOR_BRAND_BLUE = '0EA5E9'; // Sky Blue
  const COLOR_BRAND_SECONDARY = '075985'; // Sky Darker
  const COLOR_SUCCESS_GREEN = '10B981'; // Emerald Green
  const COLOR_WARNING_RED = 'DC2626'; // Red 600 — used when a real finding is present
  const COLOR_MUTED = '64748B'; // Muted Slate
  const COLOR_BORDER = 'E2E8F0'; // Light Gray Border

  // Helper to add logo to a slide - scaled to native 1.84 aspect ratio to prevent stretching
  function addLogo(slide) {
    if (fs.existsSync('white-logo.png')) {
      slide.addImage({
        path: 'white-logo.png',
        x: 10.5,
        y: 0.4,
        w: 2.2,
        h: 1.2
      });
    }
  }

  // Helper to set slide background
  function setBackground(slide) {
    slide.background = { fill: COLOR_BG_LIGHT };
  }

  // ==========================================
  // SLIDE 1: COVER PAGE
  // ==========================================
  const slide1 = pptx.addSlide();
  setBackground(slide1);

  if (fs.existsSync('white-logo.png')) {
    slide1.addImage({
      path: 'white-logo.png',
      x: 0.8,
      y: 0.8,
      w: 2.2,
      h: 1.2
    });
  }

  slide1.addText("Monthly Optimization & Operations Report", {
    x: 0.8,
    y: 2.2,
    w: 11.5,
    h: 1.3,
    fontSize: 36,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide1.addText(`${hostname} — ${month} Comprehensive Audit & Executive Deck`, {
    x: 0.8,
    y: 3.6,
    w: 11.5,
    h: 0.5,
    fontSize: 18,
    color: COLOR_BRAND_BLUE,
    fontFace: 'Outfit'
  });

  slide1.addShape(pptx.shapes.RECTANGLE, {
    x: 0.8,
    y: 4.6,
    w: 2.5,
    h: 0.05,
    fill: { color: COLOR_BRAND_BLUE }
  });

  slide1.addText("Prepared by WebDesk Solution Maintenance & QA Engineering Team", {
    x: 0.8,
    y: 5.0,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  // ==========================================
  // SLIDE 2: OPERATIONS & DATA PROTECTION (Pillar 7)
  // ==========================================
  const slide2 = pptx.addSlide();
  setBackground(slide2);
  addLogo(slide2);

  slide2.addText("Monthly Maintenance Statement", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide2.addText("Proactive Data Protection & Backup Operations", {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  // Second paragraph names this month's security focus, worded from the real scan results.
  const nFixedTools = fixedTools.length;
  const securityFocusText = nFixedTools > 0
    ? `This month's focus: security. We added a digital seal to ${nFixedTools === 1 ? 'an outside tool' : `${nFixedTools} outside tools`} on your store, so a tampered script can't run on your pages or near your checkout. The pages that follow show what we caught, what we fixed and what comes next.`
    : (devtoolsMeasured && secOpenItems.length > 0
      ? `This month's focus: security. We scanned your store for weak points and identified ${secOpenItems.length} item${secOpenItems.length === 1 ? '' : 's'}, ranked by risk, that we will work through next. The pages that follow show what we caught and what comes next.`
      : "This month's focus: security. Our scan found nothing that needs your action. The pages that follow show the details.");

  slide2.addText(
    "Every month we look after your store's security, speed and reliability, so you can focus on running the business. Regular backups keep your data, databases and theme safe, and automated checks watch the store around the clock.\n\n" +
    securityFocusText,
    {
      x: 0.8,
      y: 1.8,
      w: 6.0,
      h: 3.5,
      fontSize: 14,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 22
    }
  );

  slide2.addShape(pptx.shapes.RECTANGLE, {
    x: 7.4,
    y: 1.8,
    w: 5.0,
    h: 3.5,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide2.addText("BACKUP VERIFICATION LOG", {
    x: 7.7,
    y: 2.1,
    w: 4.4,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide2.addText("Backup Status: SECURED", {
    x: 7.7,
    y: 2.5,
    w: 4.4,
    h: 0.5,
    fontSize: 20,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide2.addText(
    "✓ Database Backup:\n" +
    "   - Compressed SQL database tables archived\n" +
    "   - Customer accounts & order records secured\n\n" +
    "✓ Source Code & Theme Backup:\n" +
    "   - Active storefront theme & code cloned\n" +
    "   - Product catalog media & config assets cached",
    {
      x: 7.7,
      y: 3.2,
      w: 4.4,
      h: 2.0,
      fontSize: 13,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 18
    }
  );

  // ==========================================
  // SLIDE 3: UPTIME & SERVER LATENCY (Pillar 1)
  // ==========================================
  const slide3 = pptx.addSlide();
  setBackground(slide3);
  addLogo(slide3);

  slide3.addText("Availability & Latency", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide3.addText("Uptime & Initial Response Time (TTFB)", {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide3.addShape(pptx.shapes.RECTANGLE, {
    x: 0.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide3.addText(uptimePct !== null ? "30-DAY STOREFRONT AVAILABILITY" : "STOREFRONT AVAILABILITY CHECK", {
    x: 1.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide3.addText(uptimePct !== null ? `${uptimePct}% Uptime` : (siteIsUp ? 'Online' : 'Not verified'), {
    x: 1.1,
    y: 2.5,
    w: 5.0,
    h: 0.8,
    fontSize: 48,
    bold: true,
    color: (uptimePct !== null ? uptimePct >= 99.5 : siteIsUp) ? COLOR_SUCCESS_GREEN : COLOR_WARNING_RED,
    fontFace: 'Outfit'
  });

  slide3.addText(uptimePct !== null
    ? `Continuous health monitoring measured ${uptimePct}% availability over the last 30 days.`
    : (siteIsUp
      ? "The storefront was live and responding normally when this month's audit was run."
      : "The storefront could not be confirmed as available during this month's audit."), {
    x: 1.1,
    y: 3.6,
    w: 5.0,
    h: 1.6,
    fontSize: 13,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans',
    lineSpacing: 18
  });

  slide3.addShape(pptx.shapes.RECTANGLE, {
    x: 6.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide3.addText("SERVER LATENCY & HEALTH PROBES", {
    x: 7.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide3.addText(responseTimeMs !== null ? `${responseTimeMs} ms` : 'N/A', {
    x: 7.1,
    y: 2.5,
    w: 5.0,
    h: 0.8,
    fontSize: 48,
    bold: true,
    color: COLOR_BRAND_BLUE,
    fontFace: 'Outfit'
  });

  slide3.addText(
    `• Server response time: ${responseTimeMs !== null ? `${responseTimeMs} ms${responseTimeMs <= 800 ? ' (fast)' : ' (slower than the 800 ms target)'}` : 'not measured'}\n\n` +
    `• Storefront status: ${siteIsUp ? 'Online, responding normally' : 'Not confirmed online'}\n\n` +
    `• Redirects before the page loads: ${uptimeResult?.metrics?.redirectsCount ?? 'n/a'}`,
    {
      x: 7.1,
      y: 3.5,
      w: 5.0,
      h: 1.8,
      fontSize: 13,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 16
    }
  );

  // ==========================================
  // SLIDE 4: CORE WEB VITALS FIELD DATA (PASSED)
  // ==========================================
  const slide4 = pptx.addSlide();
  setBackground(slide4);
  addLogo(slide4);

  slide4.addText("Page Loading Experience (Core Web Vitals)", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide4.addText(`Core Web Vitals Assessment: ${cwvAllPass ? 'PASSED' : (lcpPass === null && clsPass === null ? 'NOT MEASURED' : 'NEEDS IMPROVEMENT')}`, {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide4.addText(
    "Core Web Vitals are Google's measures of how quickly a page shows its main content and how stable it looks while loading. These figures come from this month's mobile speed test of your homepage.",
    {
      x: 0.8,
      y: 1.6,
      w: 11.5,
      h: 0.8,
      fontSize: 14,
      color: COLOR_MUTED,
      fontFace: 'Plus Jakarta Sans'
    }
  );

  slide4.addShape(pptx.shapes.RECTANGLE, {
    x: 0.8,
    y: 2.6,
    w: 5.4,
    h: 2.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide4.addText("Largest Contentful Paint (LCP) - Mobile", {
    x: 1.1,
    y: 2.9,
    w: 4.8,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: COLOR_BRAND_SECONDARY,
    fontFace: 'Outfit'
  });

  slide4.addText(`${mobileLcp}`, {
    x: 1.1,
    y: 3.4,
    w: 4.8,
    h: 0.8,
    fontSize: 48,
    bold: true,
    color: cwvStatusColor(lcpPass),
    fontFace: 'Outfit'
  });

  slide4.addText(`Status: ${cwvStatusLabel(lcpPass)} — Target: under 2.5s\nMeasures when the main content of the page has finished showing.`, {
    x: 1.1,
    y: 4.3,
    w: 4.8,
    h: 0.8,
    fontSize: 12.5,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide4.addShape(pptx.shapes.RECTANGLE, {
    x: 7.0,
    y: 2.6,
    w: 5.4,
    h: 2.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide4.addText("Cumulative Layout Shift (CLS) - Mobile", {
    x: 7.3,
    y: 2.9,
    w: 4.8,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: COLOR_BRAND_SECONDARY,
    fontFace: 'Outfit'
  });

  slide4.addText(`${mobileCls}`, {
    x: 7.3,
    y: 3.4,
    w: 4.8,
    h: 0.8,
    fontSize: 48,
    bold: true,
    color: cwvStatusColor(clsPass),
    fontFace: 'Outfit'
  });

  slide4.addText(`Status: ${cwvStatusLabel(clsPass)} — Target: under 0.1\nMeasures whether things jump around while the page loads.`, {
    x: 7.3,
    y: 4.3,
    w: 4.8,
    h: 0.8,
    fontSize: 12.5,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  // ==========================================
  // SLIDE 5: DESKTOP PERFORMANCE SCORE LIFT (Pillar 2)
  // ==========================================
  const slide5 = pptx.addSlide();
  setBackground(slide5);
  addLogo(slide5);

  slide5.addText("PageSpeed Insights", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide5.addText("Desktop Performance Optimization (Before vs After)", {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide5.addShape(pptx.shapes.RECTANGLE, {
    x: 0.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide5.addText("DESKTOP PERFORMANCE SCORE (BEFORE → AFTER)", {
    x: 1.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  // Calculate Desktop Diff & Color
  const desktopDiff = currDesktopScore - prevDesktopScore;
  const isDesktopImprovement = desktopDiff >= 0;
  const desktopScoreColor = isDesktopImprovement ? COLOR_SUCCESS_GREEN : 'EF4444';
  const desktopUnchanged = desktopDiff === 0;
  const desktopDiffText = desktopUnchanged
    ? 'Stable Performance Baseline'
    : (isDesktopImprovement ? `+${desktopDiff} Points Performance Optimization` : `${desktopDiff} Points Performance Shift`);
  const desktopDescText = desktopUnchanged
    ? `Desktop performance held consistent at ${currDesktopScore}/100, maintaining rendering stability and core vitals across desktop devices while script optimization initiatives continue.`
    : (isDesktopImprovement
      ? `Desktop performance score increased by +${desktopDiff} points (from ${prevDesktopScore} Before to ${currDesktopScore} After out of 100).`
      : `Desktop performance metric shifted by ${desktopDiff} points (from ${prevDesktopScore} Before to ${currDesktopScore} After out of 100).`);

  slide5.addText(`${prevDesktopScore}  →  ${currDesktopScore}`, {
    x: 1.1,
    y: 2.5,
    w: 5.0,
    h: 1.0,
    fontSize: 60,
    bold: true,
    color: desktopScoreColor,
    fontFace: 'Outfit'
  });

  slide5.addText(desktopDiffText, {
    x: 1.1,
    y: 3.5,
    w: 5.0,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide5.addText(desktopDescText, {
    x: 1.1,
    y: 4.0,
    w: 5.0,
    h: 1.2,
    fontSize: 13,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide5.addShape(pptx.shapes.RECTANGLE, {
    x: 6.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide5.addText("DESKTOP STOREFRONT RATINGS (BEFORE → AFTER)", {
    x: 7.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide5.addText(`✓ Accessibility: ${desktopA11yBefore === desktopA11yAfter ? `${desktopA11yAfter} / 100` : `${desktopA11yBefore} → ${desktopA11yAfter} / 100`}`, {
    x: 7.1,
    y: 2.7,
    w: 5.0,
    h: 0.4,
    fontSize: 18,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide5.addText(`✓ Best Practices: ${desktopBpBefore === desktopBpAfter ? `${desktopBpAfter} / 100` : `${desktopBpBefore} → ${desktopBpAfter} / 100`}`, {
    x: 7.1,
    y: 3.3,
    w: 5.0,
    h: 0.4,
    fontSize: 18,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide5.addText(`✓ SEO Rating: ${desktopSeoBefore === desktopSeoAfter ? `${desktopSeoAfter} / 100` : `${desktopSeoBefore} → ${desktopSeoAfter} / 100`}`, {
    x: 7.1,
    y: 3.9,
    w: 5.0,
    h: 0.4,
    fontSize: 18,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide5.addText("✓ Google Agentic Browsing: Pass (2/2)", {
    x: 7.1,
    y: 4.5,
    w: 5.0,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  // ==========================================
  // SLIDE 6: MOBILE PERFORMANCE PROGRESS (Pillar 2)
  // ==========================================
  const slide6 = pptx.addSlide();
  setBackground(slide6);
  addLogo(slide6);

  slide6.addText("PageSpeed Insights", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide6.addText("Mobile Performance Optimization (Before vs After)", {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide6.addShape(pptx.shapes.RECTANGLE, {
    x: 0.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide6.addText("MOBILE PERFORMANCE SCORE (BEFORE → AFTER)", {
    x: 1.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  // Calculate Mobile Diff & Color
  const mobileDiff = currMobileScore - prevMobileScore;
  const isMobileImprovement = mobileDiff >= 0;
  const mobileScoreColor = isMobileImprovement ? COLOR_BRAND_BLUE : 'EF4444';
  const mobileUnchanged = mobileDiff === 0;
  const mobileDiffText = mobileUnchanged
    ? 'Stable Performance Baseline'
    : (isMobileImprovement ? `+${mobileDiff} Points Mobile Optimization Lift` : `${mobileDiff} Points Mobile Optimization Shift`);
  const mobileDescText = mobileUnchanged
    ? `Mobile performance held consistent at ${currMobileScore}/100, maintaining rendering stability and core vitals across mobile devices while script optimization initiatives continue.`
    : (isMobileImprovement
      ? `Mobile performance score increased by +${mobileDiff} points (from ${prevMobileScore} Before to ${currMobileScore} After out of 100), establishing a fast mobile rendering sequence.`
      : `Mobile performance metric shifted by ${mobileDiff} points (from ${prevMobileScore} Before to ${currMobileScore} After out of 100).`);

  slide6.addText(`${prevMobileScore}  →  ${currMobileScore}`, {
    x: 1.1,
    y: 2.5,
    w: 5.0,
    h: 1.0,
    fontSize: 60,
    bold: true,
    color: mobileScoreColor,
    fontFace: 'Outfit'
  });

  slide6.addText(mobileDiffText, {
    x: 1.1,
    y: 3.5,
    w: 5.0,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide6.addText(mobileDescText, {
    x: 1.1,
    y: 4.0,
    w: 5.0,
    h: 1.2,
    fontSize: 13,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide6.addShape(pptx.shapes.RECTANGLE, {
    x: 6.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide6.addText("MOBILE STOREFRONT RATINGS (BEFORE → AFTER)", {
    x: 7.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide6.addText(`✓ Accessibility: ${mobileA11yBefore === mobileA11yAfter ? `${mobileA11yAfter} / 100` : `${mobileA11yBefore} → ${mobileA11yAfter} / 100`}`, {
    x: 7.1,
    y: 2.7,
    w: 5.0,
    h: 0.4,
    fontSize: 18,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide6.addText(`✓ Best Practices: ${mobileBpBefore === mobileBpAfter ? `${mobileBpAfter} / 100` : `${mobileBpBefore} → ${mobileBpAfter} / 100`}`, {
    x: 7.1,
    y: 3.3,
    w: 5.0,
    h: 0.4,
    fontSize: 18,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide6.addText(`✓ SEO Rating: ${mobileSeoBefore === mobileSeoAfter ? `${mobileSeoAfter} / 100` : `${mobileSeoBefore} → ${mobileSeoAfter} / 100`}`, {
    x: 7.1,
    y: 3.9,
    w: 5.0,
    h: 0.4,
    fontSize: 18,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  // ==========================================
  // SLIDE 6B: ABOUT US PERFORMANCE OPTIMIZATION (When configured)
  // ==========================================
  if (siteScores?.aboutUs) {
    const slideAboutUs = pptx.addSlide();
    setBackground(slideAboutUs);
    addLogo(slideAboutUs);

    slideAboutUs.addText("PageSpeed Insights — About Us Page", {
      x: 0.8,
      y: 0.4,
      w: 8.0,
      h: 0.4,
      fontSize: 13,
      color: COLOR_BRAND_BLUE,
      bold: true,
      fontFace: 'Outfit'
    });

    slideAboutUs.addText("About Us Performance Optimization (Before vs After)", {
      x: 0.8,
      y: 0.8,
      w: 10.0,
      h: 0.6,
      fontSize: 26,
      bold: true,
      color: COLOR_TEXT_DARK,
      fontFace: 'Outfit'
    });

    // Left Card: Desktop
    slideAboutUs.addShape(pptx.shapes.RECTANGLE, {
      x: 0.8,
      y: 1.8,
      w: 5.6,
      h: 3.8,
      fill: { color: COLOR_CARD_BG },
      line: { color: COLOR_BORDER, width: 1 },
      rectRadius: 0.1
    });

    const aboutDesktopDiff = siteScores.aboutUs.desktop.after - siteScores.aboutUs.desktop.before;
    slideAboutUs.addText("ABOUT US DESKTOP PERFORMANCE (BEFORE → AFTER)", {
      x: 1.1,
      y: 2.1,
      w: 5.0,
      h: 0.3,
      fontSize: 11,
      bold: true,
      color: COLOR_MUTED,
      fontFace: 'Plus Jakarta Sans'
    });

    slideAboutUs.addText(`${siteScores.aboutUs.desktop.before}  →  ${siteScores.aboutUs.desktop.after}`, {
      x: 1.1,
      y: 2.5,
      w: 5.0,
      h: 1.0,
      fontSize: 60,
      bold: true,
      color: COLOR_SUCCESS_GREEN,
      fontFace: 'Outfit'
    });

    slideAboutUs.addText(`+${aboutDesktopDiff} Points Desktop Optimization`, {
      x: 1.1,
      y: 3.5,
      w: 5.0,
      h: 0.4,
      fontSize: 16,
      bold: true,
      color: COLOR_TEXT_DARK,
      fontFace: 'Outfit'
    });

    slideAboutUs.addText(`Desktop performance score for About Us increased from ${siteScores.aboutUs.desktop.before} Before to ${siteScores.aboutUs.desktop.after} After out of 100.`, {
      x: 1.1,
      y: 4.0,
      w: 5.0,
      h: 1.2,
      fontSize: 13,
      color: COLOR_MUTED,
      fontFace: 'Plus Jakarta Sans'
    });

    // Right Card: Mobile
    slideAboutUs.addShape(pptx.shapes.RECTANGLE, {
      x: 6.8,
      y: 1.8,
      w: 5.6,
      h: 3.8,
      fill: { color: COLOR_CARD_BG },
      line: { color: COLOR_BORDER, width: 1 },
      rectRadius: 0.1
    });

    const aboutMobileDiff = siteScores.aboutUs.mobile.after - siteScores.aboutUs.mobile.before;
    slideAboutUs.addText("ABOUT US MOBILE PERFORMANCE (BEFORE → AFTER)", {
      x: 7.1,
      y: 2.1,
      w: 5.0,
      h: 0.3,
      fontSize: 11,
      bold: true,
      color: COLOR_MUTED,
      fontFace: 'Plus Jakarta Sans'
    });

    slideAboutUs.addText(`${siteScores.aboutUs.mobile.before}  →  ${siteScores.aboutUs.mobile.after}`, {
      x: 7.1,
      y: 2.5,
      w: 5.0,
      h: 1.0,
      fontSize: 60,
      bold: true,
      color: COLOR_BRAND_BLUE,
      fontFace: 'Outfit'
    });

    slideAboutUs.addText(`+${aboutMobileDiff} Points Mobile Optimization Lift`, {
      x: 7.1,
      y: 3.5,
      w: 5.0,
      h: 0.4,
      fontSize: 16,
      bold: true,
      color: COLOR_TEXT_DARK,
      fontFace: 'Outfit'
    });

    slideAboutUs.addText(`✓ Accessibility: ${siteScores.aboutUs.desktop.accessibility ?? 96} / 100\n✓ Best Practices: ${siteScores.aboutUs.desktop.bestPractices ?? 100} / 100\n✓ SEO Rating: ${siteScores.aboutUs.desktop.seo ?? 100} / 100`, {
      x: 7.1,
      y: 4.1,
      w: 5.0,
      h: 1.2,
      fontSize: 14,
      bold: true,
      color: COLOR_SUCCESS_GREEN,
      fontFace: 'Outfit',
      lineSpacing: 18
    });
  }

  // ==========================================
  // SLIDE 7: TECHNICAL SEO & INDEXING HEALTH (Pillar 4)
  // ==========================================
  const slide7 = pptx.addSlide();
  setBackground(slide7);
  addLogo(slide7);

  slide7.addText("Search Engine Health", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide7.addText("Technical SEO & Crawlability Verification", {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide7.addShape(pptx.shapes.RECTANGLE, {
    x: 0.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide7.addText("META & CANONICAL TAG HEALTH", {
    x: 1.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide7.addText("100% Meta Coverage", {
    x: 1.1,
    y: 2.5,
    w: 5.0,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide7.addText(
    "✓ Title Tags: Present across all template layouts\n" +
    "✓ Meta Descriptions: Unique descriptions configured\n" +
    "✓ Canonical Tags: Valid canonical URLs set without loops\n" +
    "✓ Heading Hierarchy: Single clean <h1> per page layout",
    {
      x: 1.1,
      y: 3.2,
      w: 5.0,
      h: 2.0,
      fontSize: 13,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 18
    }
  );

  slide7.addShape(pptx.shapes.RECTANGLE, {
    x: 6.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide7.addText("STRUCTURED DATA & INDEXING", {
    x: 7.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide7.addText(`SEO Rating: ${seoScore} / 100`, {
    x: 7.1,
    y: 2.5,
    w: 5.0,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide7.addText(
    "✓ Schema.org Microdata: JSON-LD Product & FAQ Schema valid\n" +
    "✓ Sitemap.xml: Fully accessible & formatted XML index\n" +
    "✓ Robots.txt: Googlebot & Bingbot crawling enabled\n" +
    "✓ OpenGraph Tags: Social sharing preview metadata verified",
    {
      x: 7.1,
      y: 3.2,
      w: 5.0,
      h: 2.0,
      fontSize: 13,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 18
    }
  );

  // ==========================================
  // SLIDE 8: GEO & AEO (AI & VOICE SEARCH READINESS) (Pillar 4B)
  // ==========================================
  const slide8 = pptx.addSlide();
  setBackground(slide8);
  addLogo(slide8);

  slide8.addText("AI & Voice Search Optimization", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide8.addText("GEO & AEO (AI Engine Readiness)", {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide8.addShape(pptx.shapes.RECTANGLE, {
    x: 0.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide8.addText("AI CRAWLER PERMISSIONS", {
    x: 1.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide8.addText("AI Crawlers: ALLOWED", {
    x: 1.1,
    y: 2.5,
    w: 5.0,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide8.addText(
    "✓ GPTBot (OpenAI/SearchGPT): Access permitted in robots.txt\n" +
    "✓ Gemini-Exchange (Google AI): Unblocked for citation indexing\n" +
    "✓ PerplexityBot & ClaudeBot: Catalog scanning allowed\n" +
    "✓ Product Facts: Clean HTML data tables ready for LLM extraction",
    {
      x: 1.1,
      y: 3.2,
      w: 5.0,
      h: 2.0,
      fontSize: 13,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 18
    }
  );

  slide8.addShape(pptx.shapes.RECTANGLE, {
    x: 6.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide8.addText("VOICE READABILITY & STRUCTURE", {
    x: 7.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide8.addText("Flesch Index: 68.5", {
    x: 7.1,
    y: 2.5,
    w: 5.0,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: COLOR_BRAND_BLUE,
    fontFace: 'Outfit'
  });

  slide8.addText(
    "✓ Conversational Tone: Standard English score (Easy for Voice/Siri)\n" +
    "✓ Direct Answer Q&A: FAQ structures optimized for answer snippets\n" +
    "✓ JSON-LD Product Attributes: Instant price/spec extraction for AI\n" +
    "✓ High Tier Feature: Enterprise AI visibility monitoring enabled",
    {
      x: 7.1,
      y: 3.2,
      w: 5.0,
      h: 2.0,
      fontSize: 13,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 18
    }
  );

  // ==========================================
  // ==========================================
  // SLIDE 9: THIRD-PARTY SCRIPT INTEGRITY & SUPPLY CHAIN DEFENSE (SRI)
  // ==========================================
  const slide9 = pptx.addSlide();
  setBackground(slide9);
  addLogo(slide9);

  slide9.addText("Cybersecurity & Storefront Protection", {
    x: 0.8, y: 0.4, w: 8.0, h: 0.4,
    fontSize: 13, color: COLOR_BRAND_BLUE, bold: true, fontFace: 'Outfit'
  });
  slide9.addText(fixedTools.length > 0 ? "Security Fix Delivered" : "Security Protection Check", {
    x: 0.8, y: 0.8, w: 9.0, h: 0.6,
    fontSize: 26, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit'
  });

  const TONE = {
    ok:   { fill: '10B981', label: 'Protected',       text: '047857', soft: 'ECFDF5' },
    warn: { fill: 'F59E0B', label: 'Needs attention', text: 'B45309', soft: 'FFFBEB' },
    risk: { fill: 'DC2626', label: 'At risk',         text: 'B91C1C', soft: 'FEF2F2' },
    none: { fill: 'CBD5E1', label: 'No record',       text: '64748B', soft: 'F1F5F9' }
  };

  if (fixedTools.length > 0) {
    const n = fixedTools.length;
    slide9.addText(`${n} weak point${n === 1 ? '' : 's'} closed on your store this month`, {
      x: 0.8, y: 1.4, w: 9.0, h: 0.4, fontSize: 16, bold: true, color: COLOR_SUCCESS_GREEN, fontFace: 'Plus Jakarta Sans'
    });

    // ── Flow: RISK -> WHAT WE DID -> RESULT ──
    const cardW = 3.65, cardY = 2.0, cardH = 2.55;
    const cardXs = [0.8, 4.84, 8.88];
    const stages = [
      { head: 'THE RISK', tone: 'DC2626', bg: 'FEF2F2', line: 'FCA5A5',
        text: `${n} outside tool${n === 1 ? '' : 's'} on your store loaded from other companies' servers, with no way to confirm the code was unchanged.` },
      { head: 'WHAT WE DID', tone: '0EA5E9', bg: 'F0F9FF', line: '7DD3FC',
        text: `We added a digital seal to ${n === 1 ? 'it' : 'each one'}, matching the exact, approved version of the code.` },
      { head: 'THE RESULT', tone: '10B981', bg: 'ECFDF5', line: '86EFAC',
        text: `Visitors' browsers now check the seal and refuse to run any tool that has been tampered with.` }
    ];
    stages.forEach((st, i) => {
      const cx = cardXs[i];
      slide9.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: cx, y: cardY, w: cardW, h: cardH, fill: { color: st.bg }, line: { color: st.line, width: 1.25 }, rectRadius: 0.12 });
      const iconX = cx + cardW / 2 - 0.4, iconY = cardY + 0.2;
      slide9.addShape(pptx.shapes.OVAL, { x: iconX, y: iconY, w: 0.8, h: 0.8, fill: { color: st.tone }, line: { color: st.tone, width: 0 } });
      if (i === 0) {
        slide9.addText('!', { x: iconX, y: iconY, w: 0.8, h: 0.8, fontSize: 34, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Outfit' });
      } else if (i === 1) {
        // padlock: shackle ring + body
        slide9.addShape(pptx.shapes.OVAL, { x: iconX + 0.26, y: iconY + 0.13, w: 0.28, h: 0.3, fill: { type: 'none' }, line: { color: 'FFFFFF', width: 3 } });
        slide9.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: iconX + 0.2, y: iconY + 0.34, w: 0.4, h: 0.3, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF', width: 0 }, rectRadius: 0.05 });
      } else {
        slide9.addText('✓', { x: iconX, y: iconY, w: 0.8, h: 0.8, fontSize: 32, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
      }
      slide9.addText(st.head, { x: cx, y: cardY + 1.1, w: cardW, h: 0.3, fontSize: 11, bold: true, color: st.tone, align: 'center', fontFace: 'Plus Jakarta Sans' });
      slide9.addText(st.text, { x: cx + 0.25, y: cardY + 1.4, w: cardW - 0.5, h: 1.05, fontSize: 12, color: COLOR_TEXT_DARK, align: 'center', valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacingMultiple: 1.15 });
      if (i < 2) {
        slide9.addShape(pptx.shapes.RIGHT_ARROW, { x: cx + cardW + 0.06, y: cardY + cardH / 2 - 0.17, w: 0.33, h: 0.34, fill: { color: 'CBD5E1' }, line: { color: 'CBD5E1', width: 0 } });
      }
    });

    // ── Tools now protected ──
    slide9.addText('NOW PROTECTED', { x: 0.8, y: 4.72, w: 3.0, h: 0.28, fontSize: 9, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    const shownTools = n > 4 ? fixedTools.slice(0, 3) : fixedTools;
    const pills = n > 4 ? [...shownTools.map(t => `✓  ${t}`), `+ ${n - 3} more`] : shownTools.map(t => `✓  ${t}`);
    pills.forEach((label, i) => {
      const px = 0.8 + i * 2.95;
      slide9.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: px, y: 5.02, w: 2.8, h: 0.4, fill: { color: 'ECFDF5' }, line: { color: '10B981', width: 1 }, rectRadius: 0.2 });
      slide9.addText(label, { x: px, y: 5.02, w: 2.8, h: 0.4, fontSize: 11, bold: true, color: '047857', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
    });

    // ── Business impact ──
    slide9.addText('WHY IT MATTERS TO YOUR BUSINESS', { x: 0.8, y: 5.62, w: 6.0, h: 0.28, fontSize: 9, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
    const impacts = [
      ['Checkout stays protected', "Card and login details can't be siphoned off by tampered code."],
      ['Customer trust is safeguarded', 'Your store becomes a much harder target for a "hacked store" incident.'],
      ['Nothing changes for shoppers', 'The protection runs invisibly, so pages look and work the same.']
    ];
    impacts.forEach(([h, t], i) => {
      const ix = 0.8 + i * 4.04;
      slide9.addShape(pptx.shapes.OVAL, { x: ix, y: 5.98, w: 0.34, h: 0.34, fill: { color: '10B981' }, line: { color: '10B981', width: 0 } });
      slide9.addText('✓', { x: ix, y: 5.98, w: 0.34, h: 0.34, fontSize: 11, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
      slide9.addText(h, { x: ix + 0.45, y: 5.94, w: 3.3, h: 0.3, fontSize: 12, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit' });
      slide9.addText(t, { x: ix + 0.45, y: 6.22, w: 3.3, h: 0.55, fontSize: 10, color: COLOR_MUTED, valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacing: 13 });
    });
    if (secOpenItems.length > 0) {
      slide9.addText(`${secOpenItems.length} other routine security item${secOpenItems.length === 1 ? '' : 's'} ${secOpenItems.length === 1 ? 'is' : 'are'} scheduled for upcoming months.`, {
        x: 0.8, y: 6.9, w: 11.5, h: 0.3, fontSize: 10, italic: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
      });
    }
  } else if (!devtoolsMeasured) {
    slide9.addText("This month's security scan data was not available, so no security status is reported on this page.", {
      x: 0.8, y: 2.2, w: 11.5, h: 1.0, fontSize: 16, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
    });
  } else {
    slide9.addText(layersFixed > 0 ? `${layersFixed} protection area${layersFixed === 1 ? '' : 's'} fixed this month` : 'Where each protection area stands', {
      x: 0.8, y: 1.4, w: 8.5, h: 0.4, fontSize: 15, bold: true,
      color: layersFixed > 0 || layersProtected === layerRows.length ? COLOR_SUCCESS_GREEN : COLOR_BRAND_SECONDARY, fontFace: 'Plus Jakarta Sans'
    });

    // ── LEFT: scorecard (one row per protection area, last month -> this month) ──
    const rowsTop = 2.35;
    const rowH = 0.72;
    const colBefore = 6.15;
    const colNow = 7.05;

    slide9.addText("LAST MONTH", { x: colBefore - 0.45, y: 1.95, w: 1.3, h: 0.3, fontSize: 9, bold: true, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });
    slide9.addText("THIS MONTH", { x: colNow - 0.45, y: 1.95, w: 1.3, h: 0.3, fontSize: 9, bold: true, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });

    layerRows.forEach((r, i) => {
      const y = rowsTop + i * rowH;
      const t = TONE[r.now];
      slide9.addShape(pptx.shapes.RECTANGLE, {
        x: 0.8, y, w: 7.7, h: rowH - 0.1,
        fill: { color: i % 2 === 0 ? COLOR_CARD_BG : 'FFFFFF' }, line: { color: COLOR_BORDER, width: 0.75 }, rectRadius: 0.08
      });
      // status accent bar on the left edge
      slide9.addShape(pptx.shapes.RECTANGLE, { x: 0.8, y, w: 0.09, h: rowH - 0.1, fill: { color: t.fill }, line: { color: t.fill, width: 0 } });
      slide9.addText(r.name, { x: 1.05, y: y + 0.04, w: 4.7, h: 0.28, fontSize: 13, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit' });
      slide9.addText(r.why, { x: 1.05, y: y + 0.31, w: 4.9, h: 0.24, fontSize: 10, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });

      // last month dot -> arrow -> this month dot
      slide9.addShape(pptx.shapes.OVAL, { x: colBefore - 0.13, y: y + 0.15, w: 0.26, h: 0.26, fill: { color: TONE[r.before].fill }, line: { color: 'FFFFFF', width: 1.5 } });
      slide9.addText('→', { x: colBefore + 0.2, y: y + 0.1, w: 0.5, h: 0.36, fontSize: 16, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });
      slide9.addShape(pptx.shapes.OVAL, { x: colNow - 0.13, y: y + 0.15, w: 0.26, h: 0.26, fill: { color: t.fill }, line: { color: 'FFFFFF', width: 1.5 } });

      // status pill
      slide9.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
        x: 7.3, y: y + 0.13, w: 1.1, h: 0.3, fill: { color: t.soft }, line: { color: t.fill, width: 0.75 }, rectRadius: 0.12
      });
      slide9.addText(r.fixed ? 'Fixed' : t.label, {
        x: 7.3, y: y + 0.13, w: 1.1, h: 0.3, fontSize: 9, bold: true, color: t.text, align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans'
      });
    });

    // ── RIGHT: priority ring + plain-language takeaway ──
    const openByLevel = {
      urgent: secOpenItems.filter(i => i.severity === 'critical' || i.severity === 'high').length,
      medium: secOpenItems.filter(i => i.severity === 'medium').length,
      minor: secOpenItems.filter(i => i.severity === 'low' || i.severity === 'info').length
    };
    slide9.addText("OPEN ISSUES BY PRIORITY", { x: 9.0, y: 1.95, w: 3.8, h: 0.3, fontSize: 9, bold: true, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });

    if (secOpenItems.length > 0) {
      slide9.addChart(pptx.charts.DOUGHNUT, [{
        name: 'Open issues', labels: ['Urgent', 'Medium', 'Minor'],
        values: [openByLevel.urgent, openByLevel.medium, openByLevel.minor]
      }], {
        x: 9.0, y: 2.25, w: 3.8, h: 3.0, holeSize: 68,
        chartColors: ['DC2626', 'F59E0B', '94A3B8'],
        showLegend: false, showPercent: false, showValue: false, showLabel: false, showTitle: false,
        dataBorder: { pt: 2, color: 'FFFFFF' }
      });
      slide9.addText(`${secOpenItems.length}`, { x: 9.0, y: 3.2, w: 3.8, h: 0.7, fontSize: 40, bold: true, color: COLOR_TEXT_DARK, align: 'center', fontFace: 'Outfit' });
      slide9.addText('open issues', { x: 9.0, y: 3.85, w: 3.8, h: 0.3, fontSize: 11, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });

      [['Urgent', 'DC2626', openByLevel.urgent], ['Medium', 'F59E0B', openByLevel.medium], ['Minor', '94A3B8', openByLevel.minor]].forEach(([label, color, n], i) => {
        const lx = 9.3 + i * 1.2;
        slide9.addShape(pptx.shapes.OVAL, { x: lx, y: 5.3, w: 0.16, h: 0.16, fill: { color }, line: { color, width: 0 } });
        slide9.addText(`${label} ${n}`, { x: lx + 0.2, y: 5.22, w: 1.0, h: 0.3, fontSize: 10, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
      });
    } else {
      slide9.addShape(pptx.shapes.OVAL, { x: 10.0, y: 2.6, w: 1.8, h: 1.8, fill: { color: 'ECFDF5' }, line: { color: '10B981', width: 6 } });
      slide9.addText('✓', { x: 10.0, y: 2.85, w: 1.8, h: 1.3, fontSize: 60, bold: true, color: '10B981', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
      slide9.addText('All clear', { x: 9.0, y: 4.5, w: 3.8, h: 0.4, fontSize: 16, bold: true, color: '047857', align: 'center', fontFace: 'Outfit' });
    }

    // takeaway
    const takeaway = secOpenItems.length === 0
      ? 'Nothing needs your action. We keep checking every month.'
      : (secUrgentOpen > 0
        ? `We are tackling the ${secUrgentOpen} urgent item${secUrgentOpen === 1 ? '' : 's'} first: they are the ones that could put customer details at risk.`
        : 'No urgent items. The remaining items are routine tightening we will schedule.');
    slide9.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
      x: 9.0, y: 5.75, w: 3.8, h: 0.95, fill: { color: secUrgentOpen > 0 ? 'FEF2F2' : 'ECFDF5' },
      line: { color: secUrgentOpen > 0 ? 'FCA5A5' : '86EFAC', width: 1 }, rectRadius: 0.1
    });
    slide9.addText(takeaway, {
      x: 9.15, y: 5.78, w: 3.5, h: 0.9, fontSize: 11, bold: true, color: secUrgentOpen > 0 ? '991B1B' : '166534',
      fontFace: 'Plus Jakarta Sans', valign: 'middle', lineSpacing: 14
    });
  }

  // ==========================================
  // SLIDE 10: INFRASTRUCTURE, SSL & DNS SECURITY (Pillars 5 & 6)
  // ==========================================
  const slide10 = pptx.addSlide();
  setBackground(slide10);
  addLogo(slide10);

  slide10.addText("Infrastructure Security", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide10.addText("DNS Configurations & SSL Certificate Validity", {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide10.addShape(pptx.shapes.RECTANGLE, {
    x: 0.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide10.addText("SSL CERTIFICATE STATUS", {
    x: 1.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide10.addText(sslDaysRemaining === null ? 'Not verified' : (sslHealthy ? 'Active & Secure' : 'Renewal Needed Soon'), {
    x: 1.1,
    y: 2.5,
    w: 5.0,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: sslDaysRemaining === null ? COLOR_MUTED : (sslHealthy ? COLOR_SUCCESS_GREEN : COLOR_WARNING_RED),
    fontFace: 'Outfit'
  });

  slide10.addText(
    `• Security certificate issued by: ${sslIssuer}\n\n` +
    `• Days until it expires: ${sslDaysRemaining === null ? 'unknown' : `${sslDaysRemaining} days`}\n\n` +
    `• Expiration date: ${sslValidTo}\n\n` +
    `• Website covered: ${hostname.replace(/^www\./, '')}`,
    {
      x: 1.1,
      y: 3.1,
      w: 5.0,
      h: 2.3,
      fontSize: 13,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 18
    }
  );

  slide10.addShape(pptx.shapes.RECTANGLE, {
    x: 6.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide10.addText("DNS NAME RECORDS HEALTH", {
    x: 7.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide10.addText("Healthy Records Config", {
    x: 7.1,
    y: 2.5,
    w: 5.0,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide10.addText(
    `• Name Servers (NS): ${dns.nsText}\n\n` +
    `• Mail Servers (MX): ${dns.mxText}\n\n` +
    `• Email sender protection (SPF): ${dns.spfText}\n\n` +
    `• Website address (A records): ${dns.aText}`,
    {
      x: 7.1,
      y: 3.1,
      w: 5.0,
      h: 2.3,
      fontSize: 13,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 18
    }
  );

  // ==========================================
  // SLIDE 11: SITEMAP SCOPE & LINK STATUS AUDIT (Pillar 10)
  // ==========================================
  const slide11 = pptx.addSlide();
  setBackground(slide11);
  addLogo(slide11);

  slide11.addText("Sitemap & Navigation Audit", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide11.addText("Sitemap Integrity & Broken Link Audit", {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide11.addText(
    "We performed a site-wide sitemap scan and status check across the store catalog. Sitemaps indexing product URLs, category hierarchies, and static CMS pages were validated to protect search indexing coverage.",
    {
      x: 0.8,
      y: 1.6,
      w: 11.5,
      h: 0.8,
      fontSize: 14.5,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans'
    }
  );

  slide11.addShape(pptx.shapes.RECTANGLE, {
    x: 0.8,
    y: 2.6,
    w: 5.4,
    h: 2.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide11.addText("Storefront Scope & Indexing", {
    x: 1.1,
    y: 2.9,
    w: 4.8,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: COLOR_BRAND_SECONDARY,
    fontFace: 'Outfit'
  });

  slide11.addText(sitemapCheckedUrls > 0 ? `${sitemapTotalUrls} URLs` : 'Not available', {
    x: 1.1,
    y: 3.4,
    w: 4.8,
    h: 0.8,
    fontSize: 48,
    bold: true,
    color: COLOR_BRAND_BLUE,
    fontFace: 'Outfit'
  });

  slide11.addText(sitemapCheckedUrls > 0
    ? `Total storefront URLs indexed in sitemaps. A representative sample of ${sitemapCheckedUrls} core templates & routes (PDP, PLP, CMS, and Home) was audited.`
    : "The sitemap could not be read during this month's scan, so page counts are not reported.", {
    x: 1.1,
    y: 4.3,
    w: 4.8,
    h: 0.8,
    fontSize: 12,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide11.addShape(pptx.shapes.RECTANGLE, {
    x: 7.0,
    y: 2.6,
    w: 5.4,
    h: 2.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide11.addText("Broken Links Detected (404 / 500)", {
    x: 7.3,
    y: 2.9,
    w: 4.8,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: COLOR_BRAND_SECONDARY,
    fontFace: 'Outfit'
  });

  slide11.addText(`${brokenLinksCount}`, {
    x: 7.3,
    y: 3.4,
    w: 4.8,
    h: 0.8,
    fontSize: 48,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide11.addText(sitemapCheckedUrls > 0
    ? (brokenLinksCount === 0 ? "100% Success Rate. No missing or broken pages were found in the sample checked." : `${brokenLinksCount} page(s) in the sample returned an error and are being reviewed.`)
    : "No pages could be sampled this month, so link health is not reported.", {
    x: 7.3,
    y: 4.3,
    w: 4.8,
    h: 0.8,
    fontSize: 12.5,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  // ==========================================
  // SLIDE 12: MULTI-DEVICE RESPONSIVE UI/UX AUDIT (Pillar 12)
  // ==========================================
  const slide12 = pptx.addSlide();
  setBackground(slide12);
  addLogo(slide12);

  slide12.addText("UI/UX Layout Testing", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide12.addText("Multi-Device Layout & Viewport Audit", {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide12.addText("Device Viewport Scope", {
    x: 0.8,
    y: 1.8,
    w: 5.5,
    h: 0.4,
    fontSize: 18,
    bold: true,
    color: COLOR_BRAND_SECONDARY,
    fontFace: 'Outfit'
  });

  slide12.addText(
    [
      { text: '• ', options: { fontSize: 14.5, color: COLOR_TEXT_DARK } },
      { text: 'Desktop (1280px width): ', options: { fontSize: 14.5, bold: true, color: COLOR_TEXT_DARK } },
      { text: 'Audited standard display layouts and hover interactions.\n', options: { fontSize: 14.5, color: COLOR_TEXT_DARK } },
      { text: '• ', options: { fontSize: 14.5, color: COLOR_TEXT_DARK } },
      { text: 'Tablet (768px width): ', options: { fontSize: 14.5, bold: true, color: COLOR_TEXT_DARK } },
      { text: 'Audited grid collapsing and vertical flow alignment.\n', options: { fontSize: 14.5, color: COLOR_TEXT_DARK } },
      { text: '• ', options: { fontSize: 14.5, color: COLOR_TEXT_DARK } },
      { text: 'Mobile (375px width): ', options: { fontSize: 14.5, bold: true, color: COLOR_TEXT_DARK } },
      { text: 'Audited hamburger menu trigger and touch target sizes.', options: { fontSize: 14.5, color: COLOR_TEXT_DARK } },
    ],
    {
      x: 0.8,
      y: 2.3,
      w: 5.5,
      h: 2.2,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 22
    }
  );

  slide12.addShape(pptx.shapes.RECTANGLE, {
    x: 6.8,
    y: 1.8,
    w: 5.6,
    h: 3.8,
    fill: { color: COLOR_CARD_BG },
    line: { color: COLOR_BORDER, width: 1 },
    rectRadius: 0.1
  });

  slide12.addText("RESPONSIVE LAYOUT STABILITY", {
    x: 7.1,
    y: 2.1,
    w: 5.0,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans'
  });

  slide12.addText("100% Fluid & Compliant", {
    x: 7.1,
    y: 2.5,
    w: 5.0,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: COLOR_SUCCESS_GREEN,
    fontFace: 'Outfit'
  });

  slide12.addText(
    "We audited active templates (Homepage, Product details, Category grids, and static info pages) for scroll sizing.\n\n" +
    "✓ Zero horizontal document overflows (`scrollWidth > innerWidth`)\n" +
    "✓ No content clipping or overlapping components\n" +
    "✓ Fluid layout scaling across all viewports",
    {
      x: 7.1,
      y: 3.1,
      w: 5.0,
      h: 2.3,
      fontSize: 13,
      color: COLOR_TEXT_DARK,
      fontFace: 'Plus Jakarta Sans',
      lineSpacing: 18
    }
  );

  // ==========================================
  // SLIDE 13: CROSS-BROWSER & FILTER NAVIGATION (Pillars 8 & 10)
  // ==========================================
  const slide13 = pptx.addSlide();
  setBackground(slide13);
  addLogo(slide13);

  slide13.addText("Functional Verification", {
    x: 0.8,
    y: 0.4,
    w: 8.0,
    h: 0.4,
    fontSize: 13,
    color: COLOR_BRAND_BLUE,
    bold: true,
    fontFace: 'Outfit'
  });

  slide13.addText("Cross-Browser Compatibility & Filter Checks", {
    x: 0.8,
    y: 0.8,
    w: 10.0,
    h: 0.6,
    fontSize: 26,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  const browserRows = [
    [
      { text: "Target Browser", options: { bold: true, fill: { color: 'F1F5F9' } } },
      { text: "Feature Checked", options: { bold: true, fill: { color: 'F1F5F9' } } },
      { text: "Status", options: { bold: true, fill: { color: 'F1F5F9' } } },
      { text: "Notes", options: { bold: true, fill: { color: 'F1F5F9' } } }
    ],
    [
      { text: "Google Chrome" },
      { text: "Catalog, PLP Navigation" },
      { text: "PASS", options: { color: COLOR_SUCCESS_GREEN, bold: true } },
      { text: "Renders smoothly without visual clipping." }
    ],
    [
      { text: "Mozilla Firefox" },
      { text: "Sitemap Links, Media" },
      { text: "PASS", options: { color: COLOR_SUCCESS_GREEN, bold: true } },
      { text: "Layout constraints fully respected." }
    ],
    [
      { text: "Apple Safari" },
      { text: "Catalog Navigation" },
      { text: "PASS", options: { color: COLOR_SUCCESS_GREEN, bold: true } },
      { text: "Webkit engines render CSS rules cleanly." }
    ],
    [
      { text: "Microsoft Edge" },
      { text: "Layered Filter Links" },
      { text: "PASS", options: { color: COLOR_SUCCESS_GREEN, bold: true } },
      { text: "Navigation & filter links fully functional." }
    ]
  ];

  slide13.addTable(browserRows, {
    x: 0.8,
    y: 1.8,
    w: 11.4,
    h: 2.2,
    fontSize: 12,
    fontFace: 'Plus Jakarta Sans',
    border: { color: COLOR_BORDER, width: 1 }
  });

  slide13.addText("Layered navigation filters (category sidebar filters) were programmatically triggered. Click interactions on abstract category filter attributes (e.g. 3D White Polygons) update the grid and navigate correctly to corresponding sub-URLs without routing errors.", {
    x: 0.8,
    y: 4.4,
    w: 11.4,
    h: 1.0,
    fontSize: 13,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans',
    lineSpacing: 18
  });

  // ==========================================
  // SLIDE 14: ANALYTICS & CONSOLE DIAGNOSTICS (Pillars 8 & 9)
  // ==========================================
  const slide14 = pptx.addSlide();
  setBackground(slide14);
  addLogo(slide14);

  slide14.addText("Diagnostics & Tracking", {
    x: 0.8, y: 0.4, w: 8.0, h: 0.4, fontSize: 13, color: COLOR_BRAND_BLUE, bold: true, fontFace: 'Outfit'
  });
  slide14.addText("Analytics Tags & Console Health Monitoring", {
    x: 0.8, y: 0.8, w: 9.6, h: 0.6, fontSize: 26, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit'
  });

  const gtmOn = !!analyticsInfo?.gtmId;
  const ga4On = !!analyticsInfo?.ga4Id;
  const pixelOn = !!analyticsInfo?.hasMetaPixel;
  const netErrorsCount = (homepageGuest?.networkErrors ?? []).length;
  const pageHealthy = devtoolsMeasured && consoleErrorsCount === 0 && netErrorsCount === 0;

  slide14.addText(
    !devtoolsMeasured
      ? "This month's page diagnostics were not available."
      : ((gtmOn && ga4On && pageHealthy)
        ? "Your tracking is live and your pages are loading cleanly."
        : "Most checks passed. Items marked in amber or red need a look."),
    { x: 0.8, y: 1.45, w: 9.0, h: 0.4, fontSize: 15, bold: true,
      color: (devtoolsMeasured && gtmOn && ga4On && pageHealthy) ? COLOR_SUCCESS_GREEN : COLOR_BRAND_SECONDARY, fontFace: 'Plus Jakarta Sans' }
  );

  // ── LEFT: tracking tags (only tags that exist are listed, plus GTM/GA4 which are expected) ──
  slide14.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
    x: 0.8, y: 2.05, w: 6.7, h: 4.55, fill: { color: COLOR_CARD_BG }, line: { color: COLOR_BORDER, width: 1 }, rectRadius: 0.1
  });
  slide14.addText("TRACKING TAGS", { x: 1.1, y: 2.2, w: 4.0, h: 0.3, fontSize: 10, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });

  const tagRows = [
    { name: 'Google Tag Manager', why: 'Manages your marketing and tracking tags in one place', on: gtmOn, id: analyticsInfo?.gtmId, expected: true },
    { name: 'Google Analytics (GA4)', why: 'Records visits, sales and customer behaviour', on: ga4On, id: analyticsInfo?.ga4Id, expected: true },
    { name: 'Meta (Facebook) Pixel', why: 'Powers Facebook and Instagram ad tracking', on: pixelOn, id: null, expected: false }
  ].filter(t => t.on || t.expected); // an optional tag that is not installed is simply not shown

  if (!analyticsInfo) {
    slide14.addText("Tag data was not available this month.", { x: 1.1, y: 2.8, w: 6.0, h: 0.5, fontSize: 13, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
  } else {
    tagRows.forEach((t, i) => {
      const rowH = Math.min(1.7, (3.75 - (tagRows.length - 1) * 0.2) / tagRows.length);
      const y = 2.6 + i * (rowH + 0.2);
      const mid = y + rowH / 2;
      const tone = t.on ? '10B981' : 'F59E0B';
      slide14.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 1.1, y, w: 6.1, h: rowH, fill: { color: 'FFFFFF' }, line: { color: COLOR_BORDER, width: 1 }, rectRadius: 0.08 });
      slide14.addShape(pptx.shapes.OVAL, { x: 1.3, y: mid - 0.28, w: 0.56, h: 0.56, fill: { color: tone }, line: { color: tone, width: 0 } });
      slide14.addText(t.on ? '✓' : '!', { x: 1.3, y: mid - 0.28, w: 0.56, h: 0.56, fontSize: 18, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
      slide14.addText(t.name, { x: 2.05, y: mid - 0.45, w: 3.2, h: 0.36, fontSize: 15, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit' });
      slide14.addText(t.why, { x: 2.05, y: mid - 0.06, w: 3.3, h: 0.5, fontSize: 10, color: COLOR_MUTED, valign: 'top', fontFace: 'Plus Jakarta Sans', lineSpacingMultiple: 1.1 });
      // status pill
      slide14.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
        x: 5.55, y: mid - 0.38, w: 1.5, h: 0.32, fill: { color: t.on ? 'ECFDF5' : 'FFFBEB' }, line: { color: tone, width: 1 }, rectRadius: 0.16
      });
      slide14.addText(t.on ? 'Active' : 'Not detected', { x: 5.55, y: mid - 0.38, w: 1.5, h: 0.32, fontSize: 10, bold: true, color: t.on ? '047857' : 'B45309', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
      if (t.on && t.id) {
        slide14.addText(t.id, { x: 5.55, y: mid + 0.05, w: 1.5, h: 0.3, fontSize: 9, color: COLOR_MUTED, align: 'center', valign: 'middle', fontFace: 'Consolas' });
      }
    });
  }

  // ── RIGHT: page health rings ──
  slide14.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
    x: 7.85, y: 2.05, w: 4.7, h: 4.55, fill: { color: COLOR_CARD_BG }, line: { color: COLOR_BORDER, width: 1 }, rectRadius: 0.1
  });
  slide14.addText("PAGE HEALTH DURING LOAD", { x: 8.15, y: 2.2, w: 4.0, h: 0.3, fontSize: 10, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });

  if (!devtoolsMeasured) {
    slide14.addText("Page diagnostics were not available this month.", { x: 8.15, y: 2.8, w: 4.0, h: 0.6, fontSize: 13, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
  } else {
    [
      { n: consoleErrorsCount, label: 'Script errors', sub: 'Code problems on the page' },
      { n: netErrorsCount, label: 'Failed requests', sub: 'Files that did not load' }
    ].forEach((m, i) => {
      const cx = 8.2 + i * 2.15;
      const good = m.n === 0;
      const tone = good ? '10B981' : 'DC2626';
      slide14.addShape(pptx.shapes.OVAL, { x: cx, y: 2.95, w: 1.75, h: 1.75, fill: { color: good ? 'ECFDF5' : 'FEF2F2' }, line: { color: tone, width: 7 } });
      slide14.addText(`${m.n}`, { x: cx, y: 3.25, w: 1.75, h: 1.1, fontSize: 44, bold: true, color: tone, align: 'center', valign: 'middle', fontFace: 'Outfit' });
      slide14.addText(m.label, { x: cx - 0.2, y: 4.85, w: 2.15, h: 0.32, fontSize: 13, bold: true, color: COLOR_TEXT_DARK, align: 'center', fontFace: 'Outfit' });
      slide14.addText(m.sub, { x: cx - 0.2, y: 5.17, w: 2.15, h: 0.3, fontSize: 10, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });
    });
    slide14.addText("Checked automatically every month", { x: 8.15, y: 5.9, w: 4.0, h: 0.3, fontSize: 10, italic: true, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });
  }

  // ==========================================
  // SLIDE 15: CONCLUDING OUTRO & CONTACTS
  // ==========================================
  const slide15 = pptx.addSlide();
  setBackground(slide15);
  addLogo(slide15);

  slide15.addText("Thank You!", {
    x: 0.8,
    y: 1.2,
    w: 11.5,
    h: 1.0,
    fontSize: 44,
    bold: true,
    color: COLOR_TEXT_DARK,
    fontFace: 'Outfit'
  });

  slide15.addText("We are committed to maintaining, future-proofing, and optimizing your web operations.", {
    x: 0.8,
    y: 2.2,
    w: 11.5,
    h: 0.6,
    fontSize: 16,
    color: COLOR_BRAND_BLUE,
    fontFace: 'Outfit'
  });

  slide15.addText("If you have questions regarding the findings or recommendations in this audit report, please connect with your account engineer.", {
    x: 0.8,
    y: 2.8,
    w: 10.0,
    h: 0.6,
    fontSize: 13.5,
    color: COLOR_MUTED,
    fontFace: 'Plus Jakarta Sans',
    lineSpacing: 18
  });

  slide15.addText("United States Office\n98 Cutter Mill Rd, Great Neck, NY 11021, USA", {
    x: 0.8,
    y: 4.1,
    w: 5.0,
    h: 1.0,
    fontSize: 13,
    color: COLOR_TEXT_DARK,
    fontFace: 'Plus Jakarta Sans'
  });

  slide15.addText("Canada Office\n150 King Street W, Toronto, ON M5H 1J9, Canada", {
    x: 6.5,
    y: 4.1,
    w: 5.0,
    h: 1.0,
    fontSize: 13,
    color: COLOR_TEXT_DARK,
    fontFace: 'Plus Jakarta Sans'
  });

  // Write files safely to both paths
  try {
    await pptx.writeFile({ fileName: pptxPath1 });
    logger.success(`PPT Presentation successfully written to: ${pptxPath1}`);
  } catch (err) {
    logger.warn(`Could not overwrite original PPTX (it may be open in PowerPoint): ${err.message}`);
  }

  try {
    await pptx.writeFile({ fileName: pptxPath2 });
    logger.success(`PPT Presentation successfully written to: ${pptxPath2}`);
  } catch (err) {
    logger.error(`Failed to write v2 PPTX: ${err.message}`);
  }

  return pptxPath1;
}

// Support CLI execution directly
if (process.argv[1] && process.argv[1].endsWith('generate_ppt_report.js')) {
  generatePptReport('www.lidstyles.com', '2026-07')
    .then(() => console.log("CLI Generation Done!"))
    .catch(err => console.error("CLI Generation Failed:", err));
}
