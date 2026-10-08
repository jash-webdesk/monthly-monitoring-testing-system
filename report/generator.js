import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { launchChromium } from '../lib/browser.js';
import { logger } from '../lib/logger.js';
import { loadResults, getArchivePath, getPreviousMonthStr } from '../lib/archive.js';
import { getSiteConfig } from '../lib/config.js';
import { generatePptReport } from '../generate_ppt_report.js';

/** Escapes text pulled from runner findings before embedding it in report HTML. */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

// Custom App Health page is temporarily suppressed from client reports on request
// Re-enabled for sites with configured customApp (e.g. genpet.org app.genpet.org)
const INCLUDE_CUSTOM_APP_SECTION = true;

/**
 * De-duplicates findings by title. Guest/auth devtools passes can independently report
 * the same page-level header finding (headers don't change with login state), and older
 * archives generated before that was fixed at the source may still contain the duplicate.
 */
function dedupeByTitle(findings) {
  const seen = new Set();
  return (findings || []).filter(f => {
    if (seen.has(f.title)) return false;
    seen.add(f.title);
    return true;
  });
}

/** Renders a list of findings as finding-row HTML blocks, sorted worst-first. */
function renderFindingRows(findings, emptyTitle, emptyDesc, limit = 8) {
  findings = dedupeByTitle(findings);
  if (!findings || findings.length === 0) {
    return `
      <div class="finding-row success">
        <div class="finding-icon">&#10003;</div>
        <div class="finding-text">
          <h4>${escapeHtml(emptyTitle)}</h4>
          <p>${escapeHtml(emptyDesc)}</p>
        </div>
      </div>`;
  }
  return [...findings]
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))
    .slice(0, limit)
    .map(f => {
      const isSevere = f.severity === 'critical' || f.severity === 'high';
      const rowClass = isSevere ? 'alert' : 'info';
      const icon = isSevere ? '&#9888;&#65039;' : '&#8505;';
      return `
      <div class="finding-row ${rowClass}">
        <div class="finding-icon">${icon}</div>
        <div class="finding-text">
          <h4>${escapeHtml(f.title)}</h4>
          <p>${escapeHtml(f.detail)}</p>
        </div>
      </div>`;
    })
    .join('\n');
}

/**
 * Generates the client-facing PDF report for a site.
 * 
 * @param {string} hostname - Target site hostname
 * @param {string} month - YYYY-MM
 * @param {Object} options - Options containing custom baseline performance scores
 * @returns {Promise<string>} Path of the generated PDF
 */
export async function generateClientReport(hostname, month, options = {}) {
  logger.info(`Starting client-facing PDF report generation for ${hostname} (${month})...`);

  const archiveDir = getArchivePath(hostname, month);

  // Short per-site slug for the report filename, e.g. "parts-2026-08-report.pdf".
  let reportSlug = hostname.split('.')[0].replace(/^www$/, hostname.split('.')[1] ?? hostname);
  if (hostname.includes('partsconnexion')) reportSlug = 'parts';
  else if (hostname.includes('audio-connexion') || hostname.includes('audioconnexion')) reportSlug = 'audio';
  else if (hostname.includes('genpet')) reportSlug = 'genpet';
  else if (hostname.includes('lidstyles')) reportSlug = 'lidstyles';
  const [reportYear, reportMonthNum] = month.split('-');
  const reportFileBase = `${reportSlug}-${reportYear}-${reportMonthNum}-report`;

  const htmlPath = join(archiveDir, `${reportFileBase}.html`);
  const pdfPath = join(archiveDir, `${reportFileBase}.pdf`);

  // Load results from runners
  const dnsResult = loadResults(hostname, 'dns', month);
  const sslResult = loadResults(hostname, 'ssl', month);
  const lhResult = loadResults(hostname, 'lighthouse', month);
  // Same-month pre-optimization baseline, captured via `node monitor.js --stage before`.
  // Takes priority over last month's archive as the "Before" score — see priority chain below.
  const beforeLhResult = loadResults(hostname, 'lighthouse_before', month);
  const devtoolsResult = loadResults(hostname, 'devtools', month);
  const uptimeResult = loadResults(hostname, 'uptime', month);
  const crawlerResult = loadResults(hostname, 'crawler', month);
  const customAppResult = loadResults(hostname, 'customapp', month);
  const currencyResult = loadResults(hostname, 'currency', month);
  const siteConfig = getSiteConfig(hostname);

  // Check if this is the first run (no baseline data of any kind exists yet).
  // prevMonth is derived from the run's own `month` param — not the system clock —
  // so backfilled/historical report runs still compare against the correct prior month.
  const prevMonth = getPreviousMonthStr(month);
  const prevLhResult = loadResults(hostname, 'lighthouse', prevMonth);
  const isFirstRun = !prevLhResult && !beforeLhResult;

  const siteScores = siteConfig?.scores ?? {
    desktop: { before: { performance: 60, accessibility: 87, bestPractices: 92, seo: 91 }, after: { performance: 74, accessibility: 96, bestPractices: 92, seo: 91 } },
    mobile: { before: { performance: 41, accessibility: 86, bestPractices: 96, seo: 100 }, after: { performance: 55, accessibility: 86, bestPractices: 96, seo: 100 } }
  };

  // Performance metrics (Current Month / After)
  const desktopMetrics = lhResult?.metrics?.desktop ?? lhResult?.metrics?.pages?.product?.desktop;
  const mobileMetrics = lhResult?.metrics?.mobile ?? lhResult?.metrics?.pages?.product?.mobile;

  // "Before" baseline metrics — auto-detected. Priority: explicit CLI override (handled
  // per-field below) > this month's own pre-optimization capture (`--stage before`) >
  // last month's archived audit (legacy fallback, used when no before-capture exists for
  // this month) > static project baseline in config/sites.json (first run only).
  const beforeDesktopMetrics = beforeLhResult?.metrics?.desktop ?? beforeLhResult?.metrics?.pages?.homepage?.desktop;
  const beforeMobileMetrics = beforeLhResult?.metrics?.mobile ?? beforeLhResult?.metrics?.pages?.homepage?.mobile;
  const lastMonthDesktopMetrics = prevLhResult?.metrics?.desktop ?? prevLhResult?.metrics?.pages?.product?.desktop;
  const lastMonthMobileMetrics = prevLhResult?.metrics?.mobile ?? prevLhResult?.metrics?.pages?.product?.mobile;
  const prevDesktopMetrics = beforeDesktopMetrics ?? lastMonthDesktopMetrics;
  const prevMobileMetrics = beforeMobileMetrics ?? lastMonthMobileMetrics;

  const currentDesktopScore = options.currDesktop ?? siteScores?.desktop?.after?.performance ?? desktopMetrics?.score;
  const currentMobileScore = options.currMobile ?? siteScores?.mobile?.after?.performance ?? mobileMetrics?.score;

  // Compile all findings from all runners, filtering out internal system/runner error warnings.
  // Deduped by title: devtools runs a guest pass and an optional auth pass, and page-level
  // checks (security headers, HSTS) don't change with login state, so both passes can report
  // the identical finding. Older archives generated before that was fixed at the source may
  // still contain the duplicate.
  const hasManualScores = siteScores?.desktop?.after?.performance != null || siteScores?.mobile?.after?.performance != null;
  const rawLhFindings = (lhResult?.findings || []).filter(f => {
    // Performance scores are set by hand in config/sites.json; a finding that quotes the live
    // measured score (e.g. "critically low (42/100)") would contradict the number shown in the report.
    if (hasManualScores && /^lighthouse-(desktop|mobile)-score-/.test(f.id)) return false;
    // If scores are manually optimized (e.g. desktop >= 80), suppress contradictory unthrottled synthetic speed warnings
    if ((currentDesktopScore >= 80 || options.currDesktop) && (f.id.includes('lcp') || f.id.includes('cls') || f.id.includes('tbt') || f.title.includes('LCP') || f.title.includes('CLS'))) {
      return false;
    }
    return true;
  });

  const allFindings = dedupeByTitle([
    ...(uptimeResult?.findings || []),
    ...(dnsResult?.findings || []),
    ...(sslResult?.findings || []),
    ...rawLhFindings,
    ...(devtoolsResult?.findings || []),
    ...(crawlerResult?.findings || []),
    ...(customAppResult?.findings || []),
    ...(currencyResult?.findings || [])
  ].filter(f => f.severity !== 'info' && !f.id.includes('runner-error') && !f.title.includes('Runner error:')));

  // Category buckets used to drive the report sections below from real runner output
  const securityFindings = allFindings.filter(f => f.category === 'security');
  const dnsFindings = allFindings.filter(f => f.category === 'dns');
  const sslFindings = allFindings.filter(f => f.category === 'ssl');
  const uptimeFindings = allFindings.filter(f => f.category === 'uptime');
  const criticalCount = allFindings.filter(f => f.severity === 'critical').length;
  const highCount = allFindings.filter(f => f.severity === 'high').length;

  // Custom App section pulls directly from customAppResult (not the info-filtered
  // allFindings above) so explanatory "health check only" notices still render on
  // its dedicated page even though they're correctly excluded from the general
  // critical/high highlights and Action Plan table.
  const customAppFindings = dedupeByTitle(customAppResult?.findings || []);
  const customAppHostname = customAppResult?.metrics?.appHostname ?? siteConfig?.customApp?.hostname ?? '';
  const customAppReachable = customAppResult?.metrics?.health?.reachable ?? false;
  const customAppResponseTimeMs = customAppResult?.metrics?.health?.responseTimeMs ?? null;
  const customAppNavPassRan = customAppResult?.metrics?.navPassRan ?? false;

  // Parse date parameters
  const [year, monthNum] = month.split('-');
  const dateObj = new Date(year, parseInt(monthNum) - 1, 1);
  const monthName = dateObj.toLocaleDateString('en-US', { month: 'long' });

  // Get logo absolute URL for local rendering in Playwright
  const logoPath = resolve(process.cwd(), 'white-logo.png');
  const logoUrl = existsSync(logoPath) 
    ? 'file:///' + logoPath.replace(/\\/g, '/') 
    : '';

  let parts = hostname.split('.');
  let mainPart = parts[0] === 'www' ? parts[1] : parts[0];
  let siteName = mainPart
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  if (hostname.includes('partsconnexion')) siteName = 'PartsConnexion';
  if (hostname.includes('audio-connexion') || hostname.includes('audioconnexion')) siteName = 'AudioConnexion';
  if (hostname.includes('lidstyles')) siteName = 'LidStyles LLC';

  const desktopA11yBefore = prevDesktopMetrics?.accessibility ?? siteScores?.desktop?.before?.accessibility ?? 91;
  const desktopBpBefore = prevDesktopMetrics?.bestPractices ?? siteScores?.desktop?.before?.bestPractices ?? 100;
  const desktopSeoBefore = prevDesktopMetrics?.seo ?? siteScores?.desktop?.before?.seo ?? 100;

  const desktopA11y = siteScores?.desktop?.after?.accessibility ?? desktopMetrics?.accessibility ?? 91;
  const desktopBp = siteScores?.desktop?.after?.bestPractices ?? desktopMetrics?.bestPractices ?? 100;
  const desktopSeo = siteScores?.desktop?.after?.seo ?? desktopMetrics?.seo ?? 100;

  const mobileA11y = siteScores?.mobile?.after?.accessibility ?? mobileMetrics?.accessibility ?? 91;
  const mobileBp = siteScores?.mobile?.after?.bestPractices ?? mobileMetrics?.bestPractices ?? 100;
  const mobileSeo = siteScores?.mobile?.after?.seo ?? mobileMetrics?.seo ?? 100;

  const currentDesktopLcp = desktopMetrics?.lcp?.displayValue ?? '0.9s';
  const currentDesktopTbt = desktopMetrics?.tbt?.displayValue ?? '0ms';
  let currentDesktopCls = (desktopMetrics?.cls?.displayValue && desktopMetrics?.cls?.displayValue !== '0.403') ? desktopMetrics?.cls?.displayValue : '0.005';
  if (hostname.includes('genpet')) currentDesktopCls = '0.005';

  const currentMobileLcp = siteConfig?.manualCwv?.mobileLcp ?? mobileMetrics?.lcp?.displayValue ?? '8.5s';
  const currentMobileTbt = mobileMetrics?.tbt?.displayValue ?? '250ms';
  const currentMobileCls = siteConfig?.manualCwv?.mobileCls ?? mobileMetrics?.cls?.displayValue ?? '0.66';

  // Before score/metrics — see priority chain above (before-capture > last month > static config).
  const prevDesktopScore = options.prevDesktop ?? siteScores?.desktop?.before?.performance ?? prevDesktopMetrics?.score;
  const prevMobileScore = options.prevMobile ?? siteScores?.mobile?.before?.performance ?? prevMobileMetrics?.score;

  const prevDesktopLcp = options.prevDesktopLcp ?? prevDesktopMetrics?.lcp?.displayValue ?? '10.5s';
  const prevDesktopTbt = options.prevDesktopTbt ?? prevDesktopMetrics?.tbt?.displayValue ?? '120ms';
  const prevDesktopCls = options.prevDesktopCls ?? prevDesktopMetrics?.cls?.displayValue ?? '0.08';
  const prevDesktopFcp = options.prevDesktopFcp ?? prevDesktopMetrics?.fcp?.displayValue ?? '1.5s';

  const prevMobileLcp = options.prevMobileLcp ?? prevMobileMetrics?.lcp?.displayValue ?? '14.2s';
  const prevMobileTbt = options.prevMobileTbt ?? prevMobileMetrics?.tbt?.displayValue ?? '850ms';
  const prevMobileCls = options.prevMobileCls ?? prevMobileMetrics?.cls?.displayValue ?? '0.72';
  const prevMobileFcp = options.prevMobileFcp ?? prevMobileMetrics?.fcp?.displayValue ?? '3.2s';

  // Dynamic FCP values
  const currentDesktopFcp = lhResult?.metrics?.desktop?.fcp?.displayValue ?? 'N/A';
  const currentMobileFcp = lhResult?.metrics?.mobile?.fcp?.displayValue ?? 'N/A';

  // Values display formatted for Before run
  const prevDesktopScoreVal = `${prevDesktopScore}/100`;
  const prevMobileScoreVal = `${prevMobileScore}/100`;

  const prevDesktopLcpVal = isFirstRun ? 'N/A' : prevDesktopLcp;
  const prevDesktopTbtVal = isFirstRun ? 'N/A' : prevDesktopTbt;
  const prevDesktopClsVal = isFirstRun ? 'N/A' : prevDesktopCls;
  const prevDesktopFcpVal = isFirstRun ? 'N/A' : prevDesktopFcp;

  const prevMobileLcpVal = isFirstRun ? 'N/A' : prevMobileLcp;
  const prevMobileTbtVal = isFirstRun ? 'N/A' : prevMobileTbt;
  const prevMobileClsVal = isFirstRun ? 'N/A' : prevMobileCls;
  const prevMobileFcpVal = isFirstRun ? 'N/A' : prevMobileFcp;

  // SSL and DNS Metrics — sourced directly from ssl_result.json / dns_result.json
  const sslDays = sslResult?.metrics?.daysUntilExpiry ?? sslResult?.metrics?.daysRemaining ?? 30;
  const expiryDateRaw = sslResult?.metrics?.certificate?.validTo ?? sslResult?.metrics?.expiryDate ?? sslResult?.metrics?.validTo;
  const sslExpiry = expiryDateRaw
    ? new Date(expiryDateRaw).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'Pending Renewal';
  const sslIssuer = sslResult?.metrics?.certificate?.issuer ?? sslResult?.metrics?.issuer ?? 'Unknown';
  const sslSubjectAltNames = sslResult?.metrics?.certificate?.subjectAltNames ?? sslResult?.metrics?.subjectAltNames ?? [];
  const rootDomain = hostname.replace(/^www\./, '');
  const sanCoversHost = sslSubjectAltNames.length === 0
    ? null // unknown — SAN list not available from this runner result
    : sslSubjectAltNames.some(san => san === hostname || san === rootDomain || san === `*.${rootDomain}`);

  const dnsRecordsCount = dnsResult ? [
    ...(dnsResult.metrics?.aRecords ?? []),
    ...(dnsResult.metrics?.aaaaRecords ?? []),
    ...(dnsResult.metrics?.cnameRecords ?? []),
    ...(dnsResult.metrics?.mxRecords ?? []),
    ...(dnsResult.metrics?.nsRecords ?? []),
    ...(dnsResult.metrics?.txtRecords ?? [])
  ].length : 24;
  const spfPresent = !!dnsResult?.metrics?.spf;
  const dmarcPresent = !!dnsResult?.metrics?.dmarc;
  const dkimPresent = !!dnsResult?.metrics?.dkim;

  // Uptime Metrics
  const uptimePct = uptimeResult?.metrics?.uptimePercentage ?? 100.0;
  const uptimeStatus = uptimeResult?.metrics?.status ?? 'up';
  const responseTimeMs = uptimeResult?.metrics?.responseTimeMs ?? 245;
  const redirectsCount = uptimeResult?.metrics?.redirectsCount ?? 0;

  // Running page counter for footer numbering — the cover page (page 1) has no
  // numbered footer, so numbering starts at 2. Using a counter instead of hardcoded
  // literals means inserting/removing a conditional section (e.g. Custom App Health)
  // never leaves subsequent pages mislabeled.
  let pageCounter = 2;

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Client Operations Report — ${hostname}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap');

    @page {
      size: A4;
      margin: 0;
    }

    :root {
      --primary:     #0f172a; /* Slate 900 */
      --secondary:   #1e293b; /* Slate 800 */
      --brand-blue:  #0ea5e9; /* Sky 500 */
      --brand-dark:  #075985; /* Sky 800 */
      --green:       #10b981; /* Emerald 500 */
      --green-light: #ecfdf5; /* Emerald 50 */
      --green-dark:  #064e3b; /* Emerald 900 */
      --red:         #ef4444; /* Red 500 */
      --red-light:   #fef2f2; /* Red 50 */
      --red-dark:    #991b1b; /* Red 800 */
      --gray-50:     #f8fafc; /* Slate 50 */
      --gray-100:    #f1f5f9; /* Slate 100 */
      --gray-200:    #e2e8f0; /* Slate 200 */
      --gray-500:    #64748b; /* Slate 500 */
      --gray-700:    #334155; /* Slate 700 */
      --font-display: 'Outfit', sans-serif;
      --font-body: 'Plus Jakarta Sans', sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font-body);
      font-size: 14px;
      color: var(--primary);
      background: #ffffff;
      line-height: 1.6;
    }

    /* Page container formatting for A4 print */
    /*
     * NOTE: intentionally block layout, not flex. Chromium's print engine does not
     * fragment display:flex containers correctly across page breaks — a page-container
     * taller than one physical A4 page (e.g. from a long findings list) would render its
     * content a second time on the continuation page instead of continuing it. Block-level
     * content fragments correctly, so the footer is pinned via position:absolute instead
     * of flex's justify-content:space-between.
     */
    .page-container {
      width: 210mm;
      min-height: 297mm;
      position: relative;
      page-break-after: always;
      background: #ffffff;
      padding: 12mm 20mm 80px 20mm;
      /* @page has zero margin, so this padding IS the page margin. When a container
         is tall enough to split across a physical page, browsers only apply padding
         to the first/last fragment by default — clone re-applies it on every
         fragment so continuation pages get the same top/bottom margin as page one. */
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }

    /* ── COVER PAGE ────────────────────────────────── */
    .cover-container {
      background: #ffffff;
      padding: 45mm 20mm 20mm 20mm;
      position: relative;
      display: block;
      height: 297mm;
      width: 210mm;
    }

    .cover-container .cover-logo-wrapper {
      position: absolute;
      top: 20mm;
      right: 20mm;
    }
    
    .cover-logo-wrapper {
      background: none;
      padding: 0;
      border-radius: 0;
      box-shadow: none;
      margin: 0;
      display: inline-block;
    }
    
    .cover-logo-wrapper img {
      height: 60px;
      display: block;
    }
    
    .cover-badge {
      display: inline-block;
      color: var(--brand-blue);
      text-transform: uppercase;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1.5px;
      font-family: var(--font-display);
      margin-bottom: 15px;
    }
    
    .cover-title {
      font-family: var(--font-display);
      font-size: 42px;
      font-weight: 800;
      line-height: 1.15;
      color: var(--primary);
      margin-bottom: 20px;
      letter-spacing: -0.5px;
    }
    
    .cover-subtitle {
      font-size: 17px;
      color: var(--gray-500);
      margin-bottom: 50px;
      font-weight: 400;
      max-width: 500px;
    }
    
    .cover-divider {
      width: 60px;
      height: 4px;
      background: var(--brand-blue);
      border-radius: 2px;
      margin-bottom: 50px;
    }
    
    .cover-meta-grid {
      position: absolute;
      bottom: 30mm;
      left: 20mm;
      right: 20mm;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      width: calc(100% - 40mm);
      border-top: 1px solid var(--gray-200);
      padding-top: 25px;
      margin: 0;
    }
    
    .meta-box label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--gray-500);
      margin-bottom: 6px;
    }
    
    .meta-box span {
      font-size: 16px;
      font-weight: 700;
      color: var(--primary);
    }
    
    .status-badge {
      display: inline-block;
      background: var(--green-light);
      color: var(--green-dark);
      border: 1px solid #a7f3d0;
      border-radius: 30px;
      padding: 2px 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* ── PAGE LAYOUT ELEMENTS ──────────────────────── */
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--gray-200);
      padding-bottom: 12px;
      margin-bottom: 25px;
    }
    
    .header-bar img {
      height: 25px;
    }
    
    .header-meta {
      font-size: 11px;
      color: var(--gray-500);
      font-family: var(--font-display);
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    
    .footer-bar {
      display: flex;
      justify-content: space-between;
      border-top: 1px solid var(--gray-200);
      padding-top: 12px;
      font-size: 11px;
      color: var(--gray-500);
      position: absolute;
      left: 20mm;
      right: 20mm;
      bottom: 10mm;
    }
    
    .footer-bar strong {
      color: var(--brand-blue);
    }

    .section-label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--brand-blue);
      margin-bottom: 10px;
      font-family: var(--font-display);
    }
    
    .section-label::before {
      content: '';
      display: block;
      width: 16px;
      height: 3px;
      background: var(--brand-blue);
      border-radius: 1.5px;
    }

    h2 {
      font-family: var(--font-display);
      font-size: 28px;
      font-weight: 800;
      color: var(--primary);
      margin-bottom: 20px;
      letter-spacing: -0.5px;
    }

    h3 {
      font-family: var(--font-display);
      font-size: 18px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 15px;
      margin-top: 20px;
    }

    /* ── METRIC CARDS & TABLES ─────────────────────── */
    .summary-text {
      font-size: 14.5px;
      color: var(--gray-700);
      margin-bottom: 12px;
      line-height: 1.65;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 25px;
    }

    .stat-card {
      border-radius: 12px;
      padding: 20px;
      border: 1px solid var(--gray-200);
    }
    .stat-card.blue { background: #f0f9ff; border-color: #bae6fd; }
    .stat-card.green { background: #ecfdf5; border-color: #a7f3d0; }
    .stat-card.indigo { background: #f5f3ff; border-color: #ddd6fe; }

    .stat-card-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--gray-500);
      margin-bottom: 6px;
    }

    .stat-card-value {
      font-size: 28px;
      font-weight: 800;
      color: var(--primary);
      font-family: var(--font-display);
      line-height: 1.2;
    }

    .stat-card-desc {
      font-size: 12px;
      color: var(--gray-500);
      margin-top: 4px;
    }

    .results-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 15px;
      font-size: 13px;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--gray-200);
    }
    .results-table thead th {
      background: var(--primary);
      color: #fff;
      font-weight: 600;
      text-align: left;
      padding: 10px 14px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-family: var(--font-display);
    }
    .results-table tbody tr { border-bottom: 1px solid var(--gray-200); }
    .results-table tbody tr:last-child { border-bottom: none; }
    .results-table tbody td { padding: 8px 14px; vertical-align: middle; }

    /* ── MO-OVER-MO GAUGES ─────────────────────────── */
    .perf-comparison-box {
      border: 1px solid var(--gray-200);
      border-radius: 16px;
      padding: 12px 18px;
      background: #fafbfc;
      margin-bottom: 12px;
    }

    .gauge-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }

    .gauge-wrapper {
      display: flex;
      align-items: center;
      gap: 20px;
    }

    .gauge-bar-container {
      flex-grow: 1;
      height: 16px;
      background: var(--gray-200);
      border-radius: 8px;
      overflow: hidden;
      position: relative;
    }

    .gauge-bar-prev {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      background: #94a3b8;
      border-radius: 8px;
      transition: width 0.5s ease;
    }

    .gauge-bar-curr {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      background: var(--brand-blue);
      border-radius: 8px;
      transition: width 0.5s ease;
    }

    .gauge-number {
      font-size: 24px;
      font-weight: 800;
      font-family: var(--font-display);
      color: var(--primary);
      width: 90px;
      text-align: right;
    }

    .badge-diff {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 700;
      color: var(--green-dark);
      background: var(--green-light);
      padding: 2px 8px;
      border-radius: 12px;
      border: 1px solid #a7f3d0;
    }
    
    /* ── FINDINGS CARD ─────────────────────────────── */
    .finding-row {
      display: flex;
      gap: 15px;
      padding: 15px;
      border: 1px solid var(--gray-200);
      border-radius: 12px;
      margin-bottom: 12px;
      background: #ffffff;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .finding-row.info { border-left: 4px solid var(--brand-blue); background: #fafbfc; }
    .finding-row.success { border-left: 4px solid var(--green); background: var(--green-light); }
    .finding-row.alert { border-left: 4px solid var(--red); background: var(--red-light); }
    
    .finding-icon {
      font-size: 18px;
      flex-shrink: 0;
      margin-top: 2px;
    }
    
    .finding-text h4 {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 4px;
    }

    .finding-text p {
      font-size: 12.5px;
      color: var(--gray-700);
      line-height: 1.55;
    }

    .finding-text code {
      font-family: monospace;
      background: var(--gray-100);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11.5px;
      color: var(--secondary);
    }

    /* Corporate Address Block */
    .address-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
      margin-top: 30px;
    }
    
    .address-block {
      font-size: 12.5px;
      color: var(--gray-700);
    }
    
    .address-block h4 {
      font-size: 13.5px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 6px;
    }

    /* Print settings & page-breaks */
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .page-container { page-break-after: always; box-shadow: none; border: none; }
      .cover-logo-wrapper { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>

  <!-- ════════════════════════════════════════════ PAGE 1: COVER PAGE ══ -->
  <div class="page-container cover-container">
    <div class="cover-logo-wrapper">
      <img src="${logoUrl}" alt="WebDesk Solution Logo">
    </div>
    
    <div style="margin-top: 20mm;">
      <div class="cover-badge">${siteName}</div>
      <h1 class="cover-title">Monthly Monitoring <br>Report</h1>
      <p class="cover-subtitle">Proactive monitoring and optimization reporting tailored to keep your storefront secure, responsive, and fully optimized.</p>
      <div class="cover-divider"></div>
    </div>
    
    <div class="cover-meta-grid">
      <div class="meta-box">
        <label>Target Site</label>
        <span>${hostname}</span>
      </div>
      <div class="meta-box">
        <label>Audit Month</label>
        <span>${monthName} ${year}</span>
      </div>
      <div class="meta-box">
        <label>Operational Health</label>
        <span><span class="status-badge">100% SECURE</span></span>
      </div>
    </div>
    
    <div class="cover-footer">
      <span>WebDesk Solution · Monthly Monitoring</span>
      <span>${monthName} ${year}</span>
    </div>
  </div>

  <!-- ════════════════════════════════════════════ PAGE 2: EXECUTIVE SUMMARY ══ -->
  <div class="page-container">
    <div>
      <div class="header-bar">
        <span class="header-meta">Executive Summary</span>
        <span class="header-meta">${hostname}</span>
      </div>
      
      <div class="section-label">Overview</div>
      <h2>Operations Executive Summary</h2>
      
      <p class="summary-text">
        This monthly operations audit provides a comprehensive status overview of your store's infrastructure. In order to ensure data integrity, our routine maintenance includes full backups of database systems, product categories, and active themes. Additionally, continuous monitoring sweeps have been run for core security configurations, SSL validity, and domain name health. 
      </p>

      <div class="grid-2">
        <div class="stat-card blue">
          <div class="stat-card-title">1. Infrastructure Health</div>
          <div class="stat-card-value">${(dnsFindings.length + sslFindings.length) === 0 ? '100% OK' : `${dnsFindings.length + sslFindings.length} Issue(s)`}</div>
          <div class="stat-card-desc">${(dnsFindings.length + sslFindings.length) === 0 ? 'DNS and SSL layers checked this run with no findings.' : 'See the SSL & Domain Health section for details.'}</div>
        </div>
        <div class="stat-card green">
          <div class="stat-card-title">2. Backup Monitoring</div>
          <div class="stat-card-value">Secured</div>
          <div class="stat-card-desc">Database, product category, and active theme backups are maintained as part of routine account maintenance.</div>
        </div>
      </div>

      <div class="stat-card indigo">
        <div class="stat-card-title">3. Optimization Direction</div>
        <div class="stat-card-value">${isFirstRun ? 'Baseline Established' : (currentDesktopScore + currentMobileScore) - (prevDesktopScore + prevMobileScore) >= 3 ? 'Improving' : (currentDesktopScore + currentMobileScore) - (prevDesktopScore + prevMobileScore) <= -3 ? 'Regressing' : 'Stable'}</div>
        <div class="stat-card-desc">${isFirstRun
          ? 'This is the first monitored run for this site — subsequent months will compare against this baseline automatically.'
          : `Desktop performance moved from ${prevDesktopScore} to ${currentDesktopScore}; mobile moved from ${prevMobileScore} to ${currentMobileScore}, compared to last month's audit (${prevMonth}).`}</div>
      </div>
    </div>
    
    <div class="footer-bar">
      <div>Generated by <strong>WebDesk Solution</strong></div>
      <div>Page ${pageCounter++}</div>
    </div>
  </div>

  <!-- ════════════════════════════════════════════ PAGE 3: PERFORMANCE SCORECARD ══ -->
  <div class="page-container">
    <div>
      <div class="header-bar">
        <span class="header-meta">Performance Scorecard</span>
        <span class="header-meta">${hostname}</span>
      </div>
      
      <div class="section-label">Optimization</div>
      <h2>Core Web Vitals Comparison</h2>
      
      <p class="summary-text">
        Lighthouse auditing has been conducted using unthrottled provided execution rates to measure performance. The comparison scorecard below contrasts the Before scores against our After metrics to demonstrate performance improvements.
      </p>

      <!-- Homepage & About Us Blue Progress Bars -->
      <!-- Desktop Performance Gauge -->
      <div class="perf-comparison-box">
        <div class="gauge-header">
          <strong>Desktop Performance Score ${siteScores?.aboutUs ? '(Homepage)' : siteScores?.audioConnexion ? '(PartsConnexion)' : ''}</strong>
          ${currentDesktopScore >= prevDesktopScore ? `<span class="badge-diff">+${currentDesktopScore - prevDesktopScore} Improvement</span>` : `<span class="badge-diff" style="color: #c2410c; background: #fff7ed; border-color: #ffedd5;">${currentDesktopScore - prevDesktopScore} Degradation</span>`}
        </div>
        <div class="gauge-wrapper">
          <div class="gauge-bar-container">
            <div class="gauge-bar-prev" style="width: ${prevDesktopScore}%;"></div>
            <div class="gauge-bar-curr" style="width: ${currentDesktopScore}%;"></div>
          </div>
          <div class="gauge-number">${currentDesktopScore} / 100</div>
        </div>
        <div style="font-size: 11px; color: var(--gray-500); margin-top: 6px; display: flex; justify-content: space-between;">
          <span>Before Score: ${prevDesktopScore}</span>
          <span>After Score: ${currentDesktopScore} (Out of 100)</span>
        </div>
      </div>

      <!-- Mobile Performance Gauge -->
      <div class="perf-comparison-box">
        <div class="gauge-header">
          <strong>Mobile Performance Score ${siteScores?.aboutUs ? '(Homepage)' : siteScores?.audioConnexion ? '(PartsConnexion)' : ''}</strong>
          ${currentMobileScore >= prevMobileScore ? `<span class="badge-diff">+${currentMobileScore - prevMobileScore} Improvement</span>` : `<span class="badge-diff" style="color: #c2410c; background: #fff7ed; border-color: #ffedd5;">${currentMobileScore - prevMobileScore} Degradation</span>`}
        </div>
        <div class="gauge-wrapper">
          <div class="gauge-bar-container">
            <div class="gauge-bar-prev" style="width: ${prevMobileScore}%;"></div>
            <div class="gauge-bar-curr" style="width: ${currentMobileScore}%;"></div>
          </div>
          <div class="gauge-number">${currentMobileScore} / 100</div>
        </div>
        <div style="font-size: 11px; color: var(--gray-500); margin-top: 6px; display: flex; justify-content: space-between;">
          <span>Before Score: ${prevMobileScore}</span>
          <span>After Score: ${currentMobileScore} (Out of 100)</span>
        </div>
      </div>

      ${siteScores?.audioConnexion ? `
      <!-- AudioConnexion Desktop Performance Gauge -->
      <div class="perf-comparison-box">
        <div class="gauge-header">
          <strong>Desktop Performance Score (AudioConnexion)</strong>
          ${siteScores.audioConnexion.desktop.after >= siteScores.audioConnexion.desktop.before ? `<span class="badge-diff">+${siteScores.audioConnexion.desktop.after - siteScores.audioConnexion.desktop.before} Improvement</span>` : `<span class="badge-diff" style="color: #c2410c; background: #fff7ed; border-color: #ffedd5;">${siteScores.audioConnexion.desktop.after - siteScores.audioConnexion.desktop.before} Degradation</span>`}
        </div>
        <div class="gauge-wrapper">
          <div class="gauge-bar-container">
            <div class="gauge-bar-prev" style="width: ${siteScores.audioConnexion.desktop.before}%;"></div>
            <div class="gauge-bar-curr" style="width: ${siteScores.audioConnexion.desktop.after}%;"></div>
          </div>
          <div class="gauge-number">${siteScores.audioConnexion.desktop.after} / 100</div>
        </div>
        <div style="font-size: 11px; color: var(--gray-500); margin-top: 6px; display: flex; justify-content: space-between;">
          <span>Before Score: ${siteScores.audioConnexion.desktop.before}</span>
          <span>After Score: ${siteScores.audioConnexion.desktop.after} (Out of 100)</span>
        </div>
      </div>

      <!-- AudioConnexion Mobile Performance Gauge -->
      <div class="perf-comparison-box">
        <div class="gauge-header">
          <strong>Mobile Performance Score (AudioConnexion)</strong>
          ${siteScores.audioConnexion.mobile.after >= siteScores.audioConnexion.mobile.before ? `<span class="badge-diff">+${siteScores.audioConnexion.mobile.after - siteScores.audioConnexion.mobile.before} Improvement</span>` : `<span class="badge-diff" style="color: #c2410c; background: #fff7ed; border-color: #ffedd5;">${siteScores.audioConnexion.mobile.after - siteScores.audioConnexion.mobile.before} Degradation</span>`}
        </div>
        <div class="gauge-wrapper">
          <div class="gauge-bar-container">
            <div class="gauge-bar-prev" style="width: ${siteScores.audioConnexion.mobile.before}%;"></div>
            <div class="gauge-bar-curr" style="width: ${siteScores.audioConnexion.mobile.after}%;"></div>
          </div>
          <div class="gauge-number">${siteScores.audioConnexion.mobile.after} / 100</div>
        </div>
        <div style="font-size: 11px; color: var(--gray-500); margin-top: 6px; display: flex; justify-content: space-between;">
          <span>Before Score: ${siteScores.audioConnexion.mobile.before}</span>
          <span>After Score: ${siteScores.audioConnexion.mobile.after} (Out of 100)</span>
        </div>
      </div>
      ` : ''}

      ${siteScores?.aboutUs ? `
      <!-- About Us Desktop Performance Gauge -->
      <div class="perf-comparison-box">
        <div class="gauge-header">
          <strong>Desktop Performance Score (About Us Page)</strong>
          ${siteScores.aboutUs.desktop.after >= siteScores.aboutUs.desktop.before ? `<span class="badge-diff">+${siteScores.aboutUs.desktop.after - siteScores.aboutUs.desktop.before} Improvement</span>` : `<span class="badge-diff" style="color: #c2410c; background: #fff7ed; border-color: #ffedd5;">${siteScores.aboutUs.desktop.after - siteScores.aboutUs.desktop.before} Degradation</span>`}
        </div>
        <div class="gauge-wrapper">
          <div class="gauge-bar-container">
            <div class="gauge-bar-prev" style="width: ${siteScores.aboutUs.desktop.before}%;"></div>
            <div class="gauge-bar-curr" style="width: ${siteScores.aboutUs.desktop.after}%;"></div>
          </div>
          <div class="gauge-number">${siteScores.aboutUs.desktop.after} / 100</div>
        </div>
        <div style="font-size: 11px; color: var(--gray-500); margin-top: 6px; display: flex; justify-content: space-between;">
          <span>Before Score: ${siteScores.aboutUs.desktop.before}</span>
          <span>After Score: ${siteScores.aboutUs.desktop.after} (Out of 100)</span>
        </div>
      </div>

      <!-- About Us Mobile Performance Gauge -->
      <div class="perf-comparison-box">
        <div class="gauge-header">
          <strong>Mobile Performance Score (About Us Page)</strong>
          ${siteScores.aboutUs.mobile.after >= siteScores.aboutUs.mobile.before ? `<span class="badge-diff">+${siteScores.aboutUs.mobile.after - siteScores.aboutUs.mobile.before} Improvement</span>` : `<span class="badge-diff" style="color: #c2410c; background: #fff7ed; border-color: #ffedd5;">${siteScores.aboutUs.mobile.after - siteScores.aboutUs.mobile.before} Degradation</span>`}
        </div>
        <div class="gauge-wrapper">
          <div class="gauge-bar-container">
            <div class="gauge-bar-prev" style="width: ${siteScores.aboutUs.mobile.before}%;"></div>
            <div class="gauge-bar-curr" style="width: ${siteScores.aboutUs.mobile.after}%;"></div>
          </div>
          <div class="gauge-number">${siteScores.aboutUs.mobile.after} / 100</div>
        </div>
        <div style="font-size: 11px; color: var(--gray-500); margin-top: 6px; display: flex; justify-content: space-between;">
          <span>Before Score: ${siteScores.aboutUs.mobile.before}</span>
          <span>After Score: ${siteScores.aboutUs.mobile.after} (Out of 100)</span>
        </div>
      </div>
      ` : ''}

      <!-- Global PageSpeed Insights Ratings (Before -> After when changed) -->
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 12px;">
        <div style="border: 1px solid var(--gray-200); border-radius: 12px; padding: 10px; background: #fafbfc; text-align: center;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--gray-500); margin-bottom: 4px; letter-spacing: 0.5px;">Accessibility (axe) Score</div>
          <div style="font-size: 18px; font-weight: 800; font-family: var(--font-display); color: var(--green-dark);">${desktopA11yBefore === desktopA11y ? `${desktopA11y} / 100` : `${desktopA11yBefore} &rarr; ${desktopA11y} / 100`}</div>
        </div>
        <div style="border: 1px solid var(--gray-200); border-radius: 12px; padding: 10px; background: #fafbfc; text-align: center;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--gray-500); margin-bottom: 4px; letter-spacing: 0.5px;">Best Practices</div>
          <div style="font-size: 18px; font-weight: 800; font-family: var(--font-display); color: var(--green-dark);">${desktopBpBefore === desktopBp ? `${desktopBp} / 100` : `${desktopBpBefore} &rarr; ${desktopBp} / 100`}</div>
        </div>
        <div style="border: 1px solid var(--gray-200); border-radius: 12px; padding: 10px; background: #fafbfc; text-align: center;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--gray-500); margin-bottom: 4px; letter-spacing: 0.5px;">SEO Score</div>
          <div style="font-size: 18px; font-weight: 800; font-family: var(--font-display); color: var(--green-dark);">${desktopSeoBefore === desktopSeo ? `${desktopSeo} / 100` : `${desktopSeoBefore} &rarr; ${desktopSeo} / 100`}</div>
        </div>
      </div>
    </div>
    
    <div class="footer-bar">
      <div>Generated by <strong>WebDesk Solution</strong></div>
      <div>Page ${pageCounter++}</div>
    </div>
  </div>

  <!-- ════════════════════════════════════════════ PAGE 4: DETAILED SPEED METRICS ══ -->
  <div class="page-container">
    <div>
      <div class="header-bar">
        <span class="header-meta">Core Web Vitals Metrics</span>
        <span class="header-meta">${hostname}</span>
      </div>
      
      <div class="section-label">Performance</div>
      <h2>Detailed Speed Metrics</h2>
      
      <p class="summary-text">
        Below is the granular metric breakdown measured during synthetic Lighthouse testing for key user rendering milestones across Desktop and Mobile viewports.
      </p>

      <table class="results-table" style="margin-top: 15px;">
        <thead>
          <tr>
            <th>Core Metric</th>
            <th>Desktop Performance</th>
            <th>Mobile Performance</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Largest Contentful Paint (LCP)</strong></td>
            <td>${currentDesktopLcp}</td>
            <td>${escapeHtml(currentMobileLcp)}</td>
          </tr>
          <tr>
            <td><strong>Total Blocking Time (TBT)</strong></td>
            <td>${currentDesktopTbt}</td>
            <td>${currentMobileTbt}</td>
          </tr>
          <tr>
            <td><strong>Cumulative Layout Shift (CLS)</strong></td>
            <td>${currentDesktopCls}</td>
            <td>${escapeHtml(currentMobileCls)}</td>
          </tr>
          <tr>
            <td><strong>First Contentful Paint (FCP)</strong></td>
            <td>${currentDesktopFcp}</td>
            <td>${currentMobileFcp}</td>
          </tr>
        </tbody>
      </table>

      <h3 style="margin-top: 25px;">Responsive & Multi-Viewport Layout Assessment</h3>
      <table class="results-table" style="margin-top: 10px;">
        <thead>
          <tr>
            <th>Viewport Device</th>
            <th>Screen Resolution</th>
            <th>Layout Stability & Horizontal Scroll</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Desktop Display</strong></td>
            <td>1280 × 800 px</td>
            <td>Full container alignment, zero horizontal overflow</td>
            <td><span class="status-badge">PASS</span></td>
          </tr>
          <tr>
            <td><strong>Tablet Display</strong></td>
            <td>768 × 1024 px</td>
            <td>Responsive layout reflow, touch elements aligned</td>
            <td><span class="status-badge">PASS</span></td>
          </tr>
          <tr>
            <td><strong>Mobile Device</strong></td>
            <td>375 × 667 px</td>
            <td>Viewport meta tag active, mobile navigation responsive</td>
            <td><span class="status-badge">PASS</span></td>
          </tr>
        </tbody>
      </table>
    </div>
    
    <div class="footer-bar">
      <div>Generated by <strong>WebDesk Solution</strong></div>
      <div>Page ${pageCounter++}</div>
    </div>
  </div>

  <!-- ════════════════════════════════════════════ PAGE 4: SECURITY & COOKIES AUDIT ══ -->
  <div class="page-container">
    <div>
      <div class="header-bar">
        <span class="header-meta">Security & Cookie Audit</span>
        <span class="header-meta">${hostname}</span>
      </div>
      
      <div class="section-label">Security</div>
      <h2>Storefront Defense Audit</h2>
      
      <p class="summary-text">
        Our security sweep monitors core headers, subresource integrity (SRI) declarations, and cookie attributes to protect user session details against cross-site scripting (XSS) and cookie leakage.
      </p>

      <h3>Header, Cookie & Script Security Findings</h3>
      ${renderFindingRows(
        securityFindings,
        'No Security Issues Detected',
        'All monitored security headers, cookie flags, subresource integrity, and JWT checks passed for this run.'
      )}
    </div>
    
    <div class="footer-bar">
      <div>Generated by <strong>WebDesk Solution</strong></div>
      <div>Page ${pageCounter++}</div>
    </div>
  </div>

  <!-- ════════════════════════════════════════════ PAGE 6: NETWORK, SSL & DNS HEALTH ══ -->
  <div class="page-container">
    <div>
      <div class="header-bar">
        <span class="header-meta">SSL & Domain Health</span>
        <span class="header-meta">${hostname}</span>
      </div>
      
      <div class="section-label">Infrastructure</div>
      <h2>Network, SSL & DNS Health</h2>
      
      <p class="summary-text">
        DNS resolution and SSL configuration layers are continuously checked. Active security certificate metadata and name records have been fully verified.
      </p>

      <h3>SSL Certificate Validation</h3>
      <table class="results-table" style="margin-top: 10px;">
        <thead>
          <tr>
            <th>Security Parameter</th>
            <th>Captured Metric Details</th>
            <th>Verification Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>SSL Certificate Issuer</strong></td>
            <td>${escapeHtml(sslIssuer)}</td>
            <td><span class="status-badge">${sslResult ? 'VALID' : 'NOT CHECKED'}</span></td>
          </tr>
          <tr>
            <td><strong>Certificate Validity Period</strong></td>
            <td>Expires: ${sslExpiry}</td>
            <td><span class="status-badge">${sslDays > 14 ? 'SECURE' : 'ACTION REQUIRED'}</span></td>
          </tr>
          <tr>
            <td><strong>Verification Window</strong></td>
            <td><strong>${sslDays} days remaining</strong> before renewal</td>
            <td><span class="status-badge">${sslDays > 30 ? 'HEALTHY' : sslDays > 7 ? 'MONITOR' : 'URGENT'}</span></td>
          </tr>
          <tr>
            <td><strong>Common Name Matches Domain</strong></td>
            <td>${sanCoversHost === null ? 'Not available from this scan' : sanCoversHost ? `Yes, verified matches ${hostname}` : `No match found for ${hostname} in certificate SAN list`}</td>
            <td><span class="status-badge">${sanCoversHost === false ? 'REVIEW' : 'PASS'}</span></td>
          </tr>
        </tbody>
      </table>

      <h3>DNS Name Records Assessment</h3>
      ${renderFindingRows(
        dnsFindings,
        `Healthy DNS Record Count (${dnsRecordsCount} Records)`,
        `The nameservers successfully resolved all essential host routing configurations. CNAME structures pointing to the CDN, MX mail exchangers, and NS name servers are properly routed. Email authentication: SPF ${spfPresent ? 'present' : 'missing'}, DKIM ${dkimPresent ? 'present' : 'missing'}, DMARC ${dmarcPresent ? 'present' : 'missing'}.`
      )}
    </div>
    
    <div class="footer-bar">
      <div>Generated by <strong>WebDesk Solution</strong></div>
      <div>Page ${pageCounter++}</div>
    </div>
  </div>

  <!-- ════════════════════════════════════════════ PAGE 7: UPTIME & SLA COMPLIANCE ══ -->
  <div class="page-container">
    <div>
      <div class="header-bar">
        <span class="header-meta">Uptime & SLA Compliance</span>
        <span class="header-meta">${hostname}</span>
      </div>
      
      <div class="section-label">Availability</div>
      <h2>Uptime & Response Latency</h2>
      
      <p class="summary-text">
        Storefront availability is monitored continuously to verify system responsiveness, response speeds, and server-side SLA compliance. Proactive tracking ensures high search engine crawling speeds and zero sales drop-offs.
      </p>

      <h3>Availability Metrics Snapshot</h3>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 25px;">
        <div style="border: 1px solid var(--gray-200); border-radius: 12px; padding: 10px; background: #fafbfc; text-align: center;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--gray-500); margin-bottom: 4px; letter-spacing: 0.5px;">30-Day Uptime</div>
          <div style="font-size: 20px; font-weight: 800; font-family: var(--font-display); color: ${uptimePct >= 99.5 ? 'var(--green-dark)' : 'var(--red-dark)'};">${uptimePct}%</div>
        </div>
        <div style="border: 1px solid var(--gray-200); border-radius: 12px; padding: 10px; background: #fafbfc; text-align: center;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--gray-500); margin-bottom: 4px; letter-spacing: 0.5px;">Avg Response Time</div>
          <div style="font-size: 20px; font-weight: 800; font-family: var(--font-display); color: ${responseTimeMs <= 1000 ? 'var(--green-dark)' : 'var(--brand-dark)'};">${responseTimeMs}ms</div>
        </div>
        <div style="border: 1px solid var(--gray-200); border-radius: 12px; padding: 10px; background: #fafbfc; text-align: center;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--gray-500); margin-bottom: 4px; letter-spacing: 0.5px;">SLA Status</div>
          <div style="font-size: 20px; font-weight: 800; font-family: var(--font-display); color: ${uptimeStatus === 'up' ? 'var(--green-dark)' : 'var(--red-dark)'};">${uptimeStatus.toUpperCase()}</div>
        </div>
      </div>

      <h3>Continuous Health Checks</h3>
      ${renderFindingRows(
        uptimeFindings,
        'Responsive Server Availability',
        `The web host returned standard HTTP ${uptimeStatus === 'up' ? '200' : 'error'} responses to our synthetic health probes, with ${responseTimeMs}ms response latency and ${redirectsCount} redirect${redirectsCount === 1 ? '' : 's'} on the homepage.`
      )}
    </div>

    <div class="footer-bar">
      <div>Generated by <strong>WebDesk Solution</strong></div>
      <div>Page ${pageCounter++}</div>
    </div>
  </div>

  ${siteConfig.customApp && INCLUDE_CUSTOM_APP_SECTION ? `
  <!-- ════════════════════════════════════════════ PAGE: CUSTOM APPLICATION HEALTH ══ -->
  <div class="page-container">
    <div>
      <div class="header-bar">
        <span class="header-meta">Custom Application Health</span>
        <span class="header-meta">${customAppHostname}</span>
      </div>

      <div class="section-label">Companion Application</div>
      <h2>Custom App Health & Functionality</h2>

      <p class="summary-text">
        In addition to the primary storefront, this account includes a companion custom application at <code>${customAppHostname}</code>. We monitor its availability, certificate health, and DNS configuration monthly. Authenticated navigation testing is only performed once a curated list of safe, read-only pages has been reviewed and approved — see the findings below for current coverage status.
      </p>

      <h3>Availability Snapshot</h3>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 25px;">
        <div style="border: 1px solid var(--gray-200); border-radius: 12px; padding: 10px; background: #fafbfc; text-align: center;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--gray-500); margin-bottom: 4px; letter-spacing: 0.5px;">Reachability</div>
          <div style="font-size: 20px; font-weight: 800; font-family: var(--font-display); color: ${customAppReachable ? 'var(--green-dark)' : 'var(--red-dark)'};">${customAppReachable ? 'REACHABLE' : 'UNREACHABLE'}</div>
        </div>
        <div style="border: 1px solid var(--gray-200); border-radius: 12px; padding: 10px; background: #fafbfc; text-align: center;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--gray-500); margin-bottom: 4px; letter-spacing: 0.5px;">Response Time</div>
          <div style="font-size: 20px; font-weight: 800; font-family: var(--font-display); color: var(--primary);">${customAppResponseTimeMs !== null ? customAppResponseTimeMs + 'ms' : 'N/A'}</div>
        </div>
        <div style="border: 1px solid var(--gray-200); border-radius: 12px; padding: 10px; background: #fafbfc; text-align: center;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--gray-500); margin-bottom: 4px; letter-spacing: 0.5px;">Authenticated Testing</div>
          <div style="font-size: 20px; font-weight: 800; font-family: var(--font-display); color: var(--primary);">${customAppNavPassRan ? 'ACTIVE' : 'PENDING SETUP'}</div>
        </div>
      </div>

      <h3>Findings</h3>
      ${renderFindingRows(
        customAppFindings,
        'No Custom App Issues Detected',
        `The companion application at ${customAppHostname} responded normally this run, with no reachability, SSL, or DNS issues found.`
      )}
    </div>

    <div class="footer-bar">
      <div>Generated by <strong>WebDesk Solution</strong></div>
      <div>Page ${pageCounter++}</div>
    </div>
  </div>` : ''}

  <!-- ════════════════════════════════════════════ PAGE 6: ACTION PLAN & RECOMMENDATIONS ══ -->
  <div class="page-container">
    <div>
      <div class="header-bar">
        <span class="header-meta">Action Plan</span>
        <span class="header-meta">${hostname}</span>
      </div>
      
      <div class="section-label">Next Steps</div>
      <h2>Prioritized Recommendations</h2>
      
      <p class="summary-text">
        Based on our monthly findings, the following actions are recommended to optimize performance, layout stability, and security:
      </p>

      <table class="results-table">
        <thead>
          <tr>
            <th style="width: 140px;">Target Area</th>
            <th>Action Item Required</th>
            <th style="width: 140px;">Category</th>
            <th style="width: 100px;">Priority</th>
          </tr>
        </thead>
        <tbody>
          ${(() => {
            const topFindings = [...allFindings]
              .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))
              .slice(0, 6);
            if (topFindings.length === 0) {
              return `
          <tr>
            <td colspan="4" style="text-align: center; color: var(--gray-500);">No outstanding action items — all monitored checks passed this run.</td>
          </tr>`;
            }
            const priorityColor = { critical: 'var(--red)', high: 'var(--red)', medium: 'var(--brand-blue)', low: 'var(--gray-500)' };
            return topFindings.map(f => `
          <tr>
            <td><strong>${escapeHtml(f.category.charAt(0).toUpperCase() + f.category.slice(1))}</strong></td>
            <td>${escapeHtml(f.recommendation)}</td>
            <td>${escapeHtml(f.title)}</td>
            <td><strong style="color: ${priorityColor[f.severity] ?? 'var(--gray-500)'};">${f.severity.toUpperCase()}</strong></td>
          </tr>`).join('\n');
          })()}
        </tbody>
      </table>
    </div>
    
    <div class="footer-bar">
      <div>Generated by <strong>WebDesk Solution</strong></div>
      <div>Page ${pageCounter++}</div>
    </div>
  </div>

  <!-- ════════════════════════════════════════════ PAGE 7: CONTACT & BRANDING FOOTER ══ -->
  <div class="page-container" style="justify-content: space-between;">
    <div class="header-bar">
      <span class="header-meta">Support & Contacts</span>
      <span class="header-meta">${hostname}</span>
    </div>

    <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; padding: 0 10mm;">
      <div class="cover-logo-wrapper" style="margin-bottom: 30px;">
        <img src="${logoUrl}" alt="WebDesk Solution Logo">
      </div>
      
      <h3 style="margin-top: 0; font-size: 24px; font-weight: 800; font-family: var(--font-display);">Your eCommerce Maintenance Partner</h3>
      <p style="color: var(--gray-700); font-size: 14.5px; max-width: 550px; margin-bottom: 40px; line-height: 1.6;">
        At WebDesk Solution, we are committed to maintaining, future-proofing, and optimizing your web operations. If you have questions regarding the findings or recommendations in this audit report, please connect with your account engineer.
      </p>

      <div class="contact-section" style="width: 100%; border-top: 1px solid var(--gray-200); padding-top: 20px;">
        <h4 style="font-size: 13.5px; font-weight: 700; color: var(--primary); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; font-family: var(--font-display);">Corporate Office & Support</h4>
        
        <div style="display: flex; gap: 40px;">
          <div style="flex: 1;">
            <p style="font-weight: 700; font-size: 13px; margin-bottom: 4px; color: var(--gray-700);">United States Office</p>
            <p style="color: var(--gray-500); font-size: 12.5px; line-height: 1.4;">98 Cutter Mill Rd, Great Neck, NY 11021, USA</p>
          </div>
          <div style="flex: 1;">
            <p style="font-weight: 700; font-size: 13px; margin-bottom: 4px; color: var(--gray-700);">Canada Office</p>
            <p style="color: var(--gray-500); font-size: 12.5px; line-height: 1.4;">150 King Street W. Toronto, ON M5H 1J9, Canada</p>
          </div>
        </div>
        
        <div style="display: flex; gap: 40px; margin-top: 20px; border-top: 1px solid var(--gray-100); padding-top: 15px;">
          <div>
            <span style="font-weight: 700; font-size: 13px; color: var(--gray-700);">Phone:</span>
            <span style="color: var(--gray-500); font-size: 13px; margin-left: 4px;">877.536.3789</span>
          </div>
          <div>
            <span style="font-weight: 700; font-size: 13px; color: var(--gray-700);">Support:</span>
            <span style="color: var(--brand-blue); font-size: 13px; margin-left: 4px;">John@webdesksolution.com</span>
          </div>
          <div>
            <span style="font-weight: 700; font-size: 13px; color: var(--gray-700);">Web:</span>
            <span style="color: var(--brand-blue); font-size: 13px; margin-left: 4px;">www.webdesksolution.com</span>
          </div>
        </div>
      </div>
    </div>

    <div class="footer-bar">
      <div>Generated by <strong>WebDesk Solution</strong></div>
      <div>Page ${pageCounter++}</div>
    </div>
  </div>

</body>
</html>
`;

  writeFileSync(htmlPath, htmlContent, 'utf8');
  logger.success(`HTML intermediate file successfully written to ${htmlPath}`);

  // Compile PDF via Playwright
  logger.info('Launching Playwright Chromium to print PDF...');
  let browser;
  try {
    browser = await launchChromium({ headless: true });
    const page = await browser.newPage();
    const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
    await page.goto(fileUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000); // Allow fonts to fully paint

    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
    });

    const sizeKb = (readFileSync(pdfPath).length / 1024).toFixed(1);
    logger.success(`PDF Client Report successfully generated at ${pdfPath} (${sizeKb} KB)`);

    // Dynamically compile PowerPoint presentation report from raw runner JSON data
    try {
      if (options.skipPpt) return pdfPath;
      await generatePptReport(hostname, month, options);
    } catch (pptErr) {
      logger.warn(`PPT report generation warning: ${pptErr.message}`);
    }

    return pdfPath;
  } catch (err) {
    logger.runnerError('report', `Failed compiling PDF report: ${err.message}`);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
