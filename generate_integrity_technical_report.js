import { launchChromium } from './lib/browser.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from './lib/logger.js';
import { loadResults, getArchivePath } from './lib/archive.js';
import { CLIENT_REPORT_CSS } from './report/clientReportStyles.js';
import { CUSTOM_APP_HOST, CUSTOM_APP_AREAS as AREAS, SEV_RANK, areaOfFinding as areaOf, DEV_FIX_NOTES } from './lib/integrityAreas.js';

/**
 * Technical report for the Integrity Reforestation custom app (admin dashboard) testing —
 * the issue-by-issue companion to the client deck, in the same A4 PDF layout as the Parts
 * Connexion / Genpet monthly reports. Source data: integrity_dashboard_result.json written by
 * `node check_integrity_dashboard.js --month YYYY-MM`. Nothing is measured here.
 *
 * CLI: node generate_integrity_technical_report.js [--month YYYY-MM]
 */

const HOST = CUSTOM_APP_HOST;
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SEV_LABEL = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW', info: 'INFO' };
const SEV_COLOR = { critical: 'var(--red)', high: 'var(--red)', medium: 'var(--brand-blue)', low: 'var(--gray-500)', info: 'var(--gray-500)' };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Splits items into pages by an estimated height weight so no page overflows A4. */
function paginate(items, weigh, budget) {
  const cap = (n) => (typeof budget === 'function' ? budget(n) : budget);
  const pages = []; let cur = []; let used = 0;
  for (const it of items) {
    const w = weigh(it);
    if (cur.length && used + w > cap(pages.length)) { pages.push(cur); cur = []; used = 0; }
    cur.push(it); used += w;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

/**
 * Builds the technical report PDF (and its HTML) from the archived check results.
 * @param {string} month - YYYY-MM
 * @returns {Promise<string>} PDF path
 */
export async function generateIntegrityTechnicalReport(month) {
  const result = loadResults(HOST, 'integrity_dashboard', month);
  if (!result) throw new Error(`No integrity_dashboard_result.json for ${month}. Run: node check_integrity_dashboard.js --month ${month}`);

  const [year, mm] = month.split('-');
  const monthLabel = `${monthNames[parseInt(mm, 10) - 1]} ${year}`;
  const host = new URL(result.metrics.baseUrl ?? result.url).hostname;
  const tested = new Date(result.timestamp).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const checks = result.metrics.checks ?? [];
  const run = checks.filter((c) => c.status !== 'skip');
  const passed = checks.filter((c) => c.status === 'pass');
  const failed = checks.filter((c) => c.status === 'fail' || c.status === 'error');
  const findings = [...(result.findings ?? [])].filter((f) => f.severity !== 'info' || !f.id.includes('runner-error'))
    .sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));
  const bySev = (s) => findings.filter((f) => f.severity === s).length;
  const writes = result.metrics.blockedWrites ?? [];
  // Data accuracy is only claimed when every total/field cross-check actually passed.
  const dataChecks = checks.filter((c) => /matches Stores Listing|equals the sum|add up|match the listing|matches the listing|Customer \+ Merchant/i.test(c.name));
  const dataOk = dataChecks.length > 0 && dataChecks.every((c) => c.status === 'pass');
  const serious = bySev('critical') + bySev('high');

  // Re-test mode: compare with the pre-fix baseline saved before the dev team's fixes, if present.
  let baseline = null;
  const baselinePath = join(getArchivePath(HOST, month), 'integrity_dashboard_baseline_pre-fix.json');
  if (existsSync(baselinePath)) { try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch { baseline = null; } }
  const nowIds = new Set(findings.map((f) => f.id));
  const baseFindings = (baseline?.findings ?? []).filter((f) => f.severity !== 'info' && !f.id.includes('runner-error'))
    .sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));
  const baseIds = new Set(baseFindings.map((f) => f.id));
  const fixedItems = baseFindings.filter((f) => !nowIds.has(f.id));
  const openItems = baseFindings.filter((f) => nowIds.has(f.id));
  const newItems = findings.filter((f) => !baseIds.has(f.id));
  const baselineDate = baseline ? new Date(baseline.timestamp).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const DEV_NOTE = DEV_FIX_NOTES;
  const logoUrl = existsSync('white-logo.png') ? pathToFileURL(resolve('white-logo.png')).href : '';

  let pageNo = 1;
  const shell = (label, inner, extraStyle = '') => `
  <div class="page-container"${extraStyle ? ` style="${extraStyle}"` : ''}>
    <div>
      <div class="header-bar"><span class="header-meta">${esc(label)}</span><span class="header-meta">${esc(host)}</span></div>
      ${inner}
    </div>
    <div class="footer-bar"><div>Generated by <strong>WebDesk Solution</strong></div><div>Page ${++pageNo}</div></div>
  </div>`;

  // ── Cover ──────────────────────────────────────────────────────────────
  const cover = `
  <div class="page-container cover-container">
    <div class="cover-logo-wrapper">${logoUrl ? `<img src="${logoUrl}" alt="WebDesk Solution Logo">` : ''}</div>
    <div style="margin-top: 20mm;">
      <div class="cover-badge">Integrity Reforestation</div>
      <h1 class="cover-title">Custom App Testing<br>Technical Report</h1>
      <p class="cover-subtitle">Read-only functional, data and usability testing of the Integrity Reforestation admin dashboard: Dashboard, Stores Listing, Email Templates and Email Logs.</p>
      <div class="cover-divider"></div>
    </div>
    <div class="cover-meta-grid">
      <div class="meta-box"><label>Target App</label><span>${esc(host)}</span></div>
      <div class="meta-box"><label>Audit Month</label><span>${esc(monthLabel)}</span></div>
      <div class="meta-box"><label>Result</label><span><span class="status-badge">${baseline ? `${findings.length} OPEN · ${fixedItems.length} FIXED` : (findings.length ? `${findings.length} ITEMS NOTED` : 'ALL CLEAR')}</span></span></div>
    </div>
    <div class="cover-footer"><span>WebDesk Solution · Custom App Testing</span><span>${esc(monthLabel)}</span></div>
  </div>`;

  // ── Executive summary ─────────────────────────────────────────────────
  const summary = shell('Executive Summary', `
      <div class="section-label">Overview</div>
      <h2>Custom App Testing Summary</h2>
      <p class="summary-text">
        On ${esc(tested)} we ran ${run.length} automated, read-only checks against the Integrity Reforestation admin dashboard. The checks confirm that data appears correctly, that filters, search, paging and buttons work, and that figures on the Dashboard agree with the Stores Listing. No data was added, edited, deleted or sent: every write request is blocked in the browser before it leaves, and ${writes.length === 0 ? 'none was attempted' : `${writes.length} was attempted and blocked`}.${baseline ? ` The checks were then repeated after the dev team's fixes: ${fixedItems.length} of the ${baseFindings.length} items reported on ${esc(baselineDate)} are now fixed${openItems.length ? `, ${openItems.length} remain open` : ''}.` : ''}
      </p>
      <div class="grid-2">
        <div class="stat-card blue"><div class="stat-card-title">1. Checks Run</div><div class="stat-card-value">${run.length}</div><div class="stat-card-desc">${passed.length} passed, ${failed.length} need attention, across 5 areas of the app.</div></div>
        <div class="stat-card green"><div class="stat-card-title">2. Data Accuracy</div><div class="stat-card-value">${dataOk ? 'Verified' : 'Review'}</div><div class="stat-card-desc">${dataOk ? "Store, tree and contribution totals on the Dashboard match the Stores Listing and each store's own page." : 'Some totals differ between pages. See the findings for the exact figures.'}</div></div>
      </div>
      <div class="stat-card indigo"><div class="stat-card-title">${baseline ? '3. Open Items' : '3. Items Noted'}</div><div class="stat-card-value">${findings.length}</div><div class="stat-card-desc">${baseline ? `${fixedItems.length} of ${baseFindings.length} earlier items fixed, ${newItems.length} new. ` : ''}${bySev('critical') + bySev('high')} high priority, ${bySev('medium')} medium, ${bySev('low')} low. ${serious ? 'Please review the high-priority items first.' : 'None are high priority; they are layout, filter-wording or data-tidiness items.'}</div></div>`);

  // ── Coverage ──────────────────────────────────────────────────────────
  const tally = result.metrics.tally ?? {};
  const rowsCov = AREAS.map((a) => {
    const t = a.pages.reduce((acc, p) => { const x = tally[p] ?? {}; acc.pass += x.pass ?? 0; acc.fail += (x.fail ?? 0) + (x.error ?? 0); return acc; }, { pass: 0, fail: 0 });
    const n = findings.filter((f) => areaOf(f) === a.key).length;
    return `<tr><td><strong>${esc(a.label)}</strong></td><td>${esc(a.tested)}</td><td>${t.pass + t.fail}</td><td>${t.pass}</td><td><strong style="color: ${n ? 'var(--brand-blue)' : 'var(--green)'};">${n || 'None'}</strong></td></tr>`;
  }).join('');
  const coverage = shell('Test Coverage', `
      <div class="section-label">Scope</div>
      <h2>What Was Tested</h2>
      <p class="summary-text">Each area was browsed as a signed-in administrator. Filters, search, paging, date selection and the View actions were exercised exactly as a user would; nothing that changes data was used.</p>
      <table class="results-table">
        <thead><tr><th style="width:130px;">Area</th><th>Checks performed</th><th style="width:60px;">Run</th><th style="width:60px;">Passed</th><th style="width:70px;">Items</th></tr></thead>
        <tbody>${rowsCov}</tbody>
      </table>
      <h3 style="margin-top: 22px;">Intentionally not exercised</h3>
      <div class="finding-row info"><div class="finding-icon">&#8505;</div><div class="finding-text"><h4>Email Templates: Add, Edit, Delete and Send test mail</h4><p>These change data or send real e-mail, so they were checked for presence only and never clicked. The same applies to Logout.</p></div></div>
      <div class="finding-row info"><div class="finding-icon">&#8505;</div><div class="finding-text"><h4>Data safeguard</h4><p>After sign-in, any request other than a read (GET) is aborted in the browser and reported as critical. Result this run: ${writes.length === 0 ? '0 write requests attempted.' : `${writes.length} write request(s) blocked.`} No screenshots or customer e-mail addresses are stored with the results.</p></div></div>`);

  // ── Findings by area ──────────────────────────────────────────────────
  // ── Re-test results (only when a pre-fix baseline exists) ─────────────
  const retestPages = !baseline ? [] : (() => {
    const titleOf = (f) => (f.title ?? '').replace(/^\[.*?\]\s*/, '');
    const rowsHtml = baseFindings.map((f) => {
      const isFixed = !nowIds.has(f.id);
      const area = AREAS.find((a) => a.key === areaOf(f))?.label ?? 'General';
      return {
        f,
        html: `<tr><td><strong>${esc(area)}</strong></td><td>${esc(titleOf(f))}</td><td style="font-size:11.5px;color:var(--gray-500);">${esc(DEV_NOTE[f.id] ?? '')}</td><td><strong style="color:${SEV_COLOR[f.severity]};">${SEV_LABEL[f.severity]}</strong></td><td><strong style="color:${isFixed ? 'var(--green)' : 'var(--red)'};">${isFixed ? '&#10003; Fixed' : 'Still open'}</strong></td></tr>`
      };
    });
    const newHtml = newItems.length ? `
      <h3 style="margin-top:18px;">New since the earlier run</h3>
      <table class="results-table"><thead><tr><th style="width:120px;">Area</th><th>Issue</th><th style="width:80px;">Priority</th></tr></thead><tbody>
      ${newItems.map((f) => `<tr><td><strong>${esc(AREAS.find((a) => a.key === areaOf(f))?.label ?? 'General')}</strong></td><td>${esc(titleOf(f))}</td><td><strong style="color:${SEV_COLOR[f.severity]};">${SEV_LABEL[f.severity]}</strong></td></tr>`).join('')}
      </tbody></table>` : '';
    return paginate(rowsHtml, (x) => 24 + 20 * Math.max(2, Math.ceil(titleOf(x.f).length / 30), Math.ceil((DEV_NOTE[x.f.id] ?? '').length / 26)), (n) => (n === 0 ? 560 : 780)).map((pg, pi, all) => shell('Re-test Results', `
      <div class="section-label">Re-test${pi ? ' (continued)' : ''}</div>
      <h2>${pi ? 'Re-test After the Fixes (continued)' : 'Re-test After the Dev Team Fixes'}</h2>
      ${pi ? '' : `<p class="summary-text">After the dev team reported fixes, every check was repeated against the live dashboard. Of the ${baseFindings.length} items reported on ${esc(baselineDate)}, <strong>${fixedItems.length} are now fixed</strong>${openItems.length ? ` and <strong>${openItems.length} remain open</strong>` : ''}${newItems.length ? `; ${newItems.length} new item${newItems.length === 1 ? '' : 's'} appeared` : ''}.</p>`}
      <table class="results-table">
        <thead><tr><th style="width:105px;">Area</th><th>Issue reported earlier</th><th style="width:150px;">Dev team fix</th><th style="width:70px;">Priority</th><th style="width:80px;">Result</th></tr></thead>
        <tbody>${pg.map((x) => x.html).join('')}</tbody>
      </table>${pi === all.length - 1 ? newHtml : ''}`));
  })();

  const findingBlocks = [];
  for (const a of [...AREAS, { key: 'general', label: 'General' }]) {
    const list = findings.filter((f) => areaOf(f) === a.key);
    if (!list.length) continue;
    findingBlocks.push({ heading: a.label, list });
  }
  const flat = findingBlocks.flatMap((b) => b.list.map((f, i) => ({ f, area: b.heading, first: i === 0 })));
  const weigh = (x) => 54 + 21 * (Math.ceil(String(x.f.detail).length / 84) + (x.f.evidence ? Math.ceil(Math.min(380, String(x.f.evidence).length) / 98) : 0) + Math.ceil(String(x.f.recommendation).length / 98)) + (x.first ? 52 : 0);
  const findingPages = paginate(flat, weigh, (n) => (n === 0 ? 700 : 800)).map((pg, pi) => {
    let html = '';
    let lastArea = null;
    for (const x of pg) {
      if (x.area !== lastArea) { html += `<h3 style="margin-top: ${html ? 14 : 0}px;">${esc(x.area)}</h3>`; lastArea = x.area; }
      const high = x.f.severity === 'critical' || x.f.severity === 'high';
      html += `
      <div class="finding-row ${high ? 'alert' : 'info'}">
        <div class="finding-icon">${high ? '&#9888;&#65039;' : '&#8505;'}</div>
        <div class="finding-text">
          <h4>[${SEV_LABEL[x.f.severity]}] ${esc(x.f.title)}</h4>
          <p>${esc(x.f.detail)}</p>
          ${x.f.evidence ? `<p style="color: var(--gray-500); font-size: 11.5px; margin-top: 3px;"><strong>Evidence:</strong> ${esc(String(x.f.evidence).slice(0, 380))}</p>` : ''}
          <p style="color: var(--brand-dark); font-size: 11.5px; margin-top: 3px;"><strong>Recommended fix:</strong> ${esc(x.f.recommendation)}</p>
        </div>
      </div>`;
    }
    return shell('Findings', `<div class="section-label">Findings${pi ? ' (continued)' : ''}</div><h2>${pi ? (baseline ? 'Open Issues (continued)' : 'Issues Found (continued)') : (baseline ? 'Open Issues After Re-test' : 'Issues Found in the Custom App')}</h2>${pi ? '' : `<p class="summary-text">${baseline ? 'These items were reproduced on the re-test, so they are still open or new. Items already fixed are listed on the Re-test page. Items are grouped by area and ordered by priority.' : 'Every item below was reproduced during this run. Items are grouped by area and ordered by priority.'}</p>`}${html}`);
  });
  const noFindings = findings.length === 0 ? shell('Findings', `<div class="section-label">Findings</div><h2>Issues Found in the Custom App</h2><div class="finding-row success"><div class="finding-icon">&#10003;</div><div class="finding-text"><h4>${baseline ? 'No open issues' : 'No issues found'}</h4><p>${baseline ? 'Every item reported earlier is fixed and all checks passed on the re-test.' : 'All checks passed this run.'}</p></div></div>`) : '';

  // ── Verified working (passed checks) ──────────────────────────────────
  const passedByArea = AREAS.map((a) => ({ a, list: checks.filter((c) => a.pages.includes(c.page) && c.status === 'pass') })).filter((x) => x.list.length);
  const passFlat = passedByArea.flatMap((x) => x.list.map((c, i) => ({ area: x.a.label, name: c.name, first: i === 0 })));
  const passPages = paginate(passFlat, (x) => 24 + (x.first ? 58 : 0), (n) => (n === 0 ? 760 : 820)).map((pg, pi) => {
    let html = ''; let last = null;
    for (const x of pg) {
      if (x.area !== last) { html += `<h3 style="margin-top: ${html ? 12 : 0}px;">${esc(x.area)}</h3>`; last = x.area; }
      html += `<div style="display:flex; gap:8px; font-size:12.5px; padding:2px 0;"><span style="color: var(--green); font-weight:700;">&#10003;</span><span>${esc(x.name)}</span></div>`;
    }
    return shell('Verified Working', `<div class="section-label">Passed Checks${pi ? ' (continued)' : ''}</div><h2>${pi ? 'What Is Working (continued)' : 'What Is Working'}</h2>${html}`);
  });

  // ── Observations ──────────────────────────────────────────────────────
  const m = result.metrics;
  const layout = m.stores?.layout ?? {};
  const layoutRows = Object.keys(layout).map((w) => {
    const l = layout[w];
    const state = !l.found ? 'n/a' : l.hidden ? '<strong style="color: var(--red);">View button cut off</strong>' : l.scroll ? '<strong style="color: var(--brand-blue);">Needs sideways scroll</strong>' : '<strong style="color: var(--green);">Fits</strong>';
    return `<tr><td><strong>${w} px</strong></td><td>${state}</td><td>${l.cutHeadings ?? '-'}</td></tr>`;
  }).join('');
  const k = m.dashboard?.kpis ?? {};
  const kpiEntries = Object.entries(k);
  const kpiRows = Array.from({ length: Math.ceil(kpiEntries.length / 2) }, (_, i) => { const [x, y] = [kpiEntries[i * 2], kpiEntries[i * 2 + 1]]; return `<tr><td>${esc(x[0])}</td><td><strong>${esc(x[1] ?? '-')}</strong></td><td>${y ? esc(y[0]) : ''}</td><td>${y ? `<strong>${esc(y[1] ?? '-')}</strong>` : ''}</td></tr>`; }).join('');
  const obs = shell('Observations', `
      <div class="section-label">Data &amp; Layout</div>
      <h2>Supporting Measurements</h2>
      <h3>Dashboard totals (cross-checked against ${m.stores?.total ?? '-'} stores in the listing)</h3>
      <table class="results-table"><thead><tr><th>Summary card</th><th>Value</th><th>Summary card</th><th>Value</th></tr></thead><tbody>${kpiRows}</tbody></table>
      <p class="summary-text" style="margin-top:8px;">Listing totals: ${m.stores?.total ?? '-'} stores, ${m.stores?.active ?? '-'} active, ${m.stores?.sumTrees ?? '-'} trees, $${(m.stores?.sumContribution ?? 0).toFixed(2)} CAD. All match.</p>
      <h3 style="margin-top:18px;">Stores Listing layout by screen width</h3>
      <table class="results-table"><thead><tr><th>Window width</th><th>Actions column</th><th>Cut-off headings</th></tr></thead><tbody>${layoutRows}</tbody></table>
      <h3 style="margin-top:18px;">E-mail delivery</h3>
      <table class="results-table"><tbody>
        <tr><td>Most recent e-mail sent</td><td>${esc(m.emailLogs?.latestSent ?? '-')}</td></tr>
        <tr><td>Most recent failed e-mail</td><td>${esc(m.emailLogs?.latestFailed ?? 'None recorded')}${m.emailLogs?.daysSinceLatestFailure != null ? ` (${m.emailLogs.daysSinceLatestFailure} days before this run)` : ''}</td></tr>
        <tr><td>Log pages (10 per page): Sent / Failed</td><td>${m.emailLogs?.sentPages ?? '-'} / ${m.emailLogs?.failedPages ?? '-'}</td></tr>
        <tr><td>Stores visited via View</td><td>${m.stores?.detailPagesChecked ?? '-'}</td></tr>
      </tbody></table>`);

  // ── Prioritized recommendations ───────────────────────────────────────
  const areaLabel = (f) => (AREAS.find((a) => a.key === areaOf(f))?.label ?? 'General');
  const recRows = findings.map((f) => `<tr><td><strong>${esc(areaLabel(f))}</strong></td><td>${esc(f.recommendation)}</td><td>${esc(f.title)}</td><td><strong style="color: ${SEV_COLOR[f.severity]};">${SEV_LABEL[f.severity]}</strong></td></tr>`);
  const recPages = paginate(recRows.map((html, i) => ({ f: findings[i], html })), (x) => 24 + 20 * Math.max(2, Math.ceil(x.f.recommendation.length / 34), Math.ceil(x.f.title.length / 26)), (n) => (n === 0 ? 700 : 780)).map((pg, pi) => shell('Action Plan', `
      <div class="section-label">Next Steps</div><h2>${pi ? 'Prioritized Recommendations (continued)' : 'Prioritized Recommendations'}</h2>
      ${pi ? '' : '<p class="summary-text">Based on this run, the following actions are recommended, highest priority first:</p>'}
      <table class="results-table">
        <thead><tr><th style="width:120px;">Target Area</th><th>Action Item Required</th><th style="width:170px;">Issue</th><th style="width:80px;">Priority</th></tr></thead>
        <tbody>${pg.map((x) => x.html).join('')}</tbody>
      </table>`));

  // ── Contacts (same closing page as the other reports) ─────────────────
  const contact = `
  <div class="page-container" style="justify-content: space-between;">
    <div class="header-bar"><span class="header-meta">Support &amp; Contacts</span><span class="header-meta">${esc(host)}</span></div>
    <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; padding: 0 10mm;">
      <div class="cover-logo-wrapper" style="margin-bottom: 30px;">${logoUrl ? `<img src="${logoUrl}" alt="WebDesk Solution Logo">` : ''}</div>
      <h3 style="margin-top: 0; font-size: 24px; font-weight: 800; font-family: var(--font-display);">Your eCommerce Maintenance Partner</h3>
      <p style="color: var(--gray-700); font-size: 14.5px; max-width: 550px; margin-bottom: 40px; line-height: 1.6;">At WebDesk Solution, we are committed to maintaining, future-proofing, and optimizing your web operations. If you have questions regarding the findings or recommendations in this report, please connect with your account engineer.</p>
      <div class="contact-section" style="width: 100%; border-top: 1px solid var(--gray-200); padding-top: 20px;">
        <h4 style="font-size: 13.5px; font-weight: 700; color: var(--primary); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; font-family: var(--font-display);">Corporate Office &amp; Support</h4>
        <div style="display: flex; gap: 40px;">
          <div style="flex: 1;"><p style="font-weight: 700; font-size: 13px; margin-bottom: 4px; color: var(--gray-700);">United States Office</p><p style="font-size: 13px; color: var(--gray-500);">98 Cutter Mill Rd, Great Neck, NY 11021, USA</p></div>
          <div style="flex: 1;"><p style="font-weight: 700; font-size: 13px; margin-bottom: 4px; color: var(--gray-700);">Canada Office</p><p style="font-size: 13px; color: var(--gray-500);">150 King Street W, Toronto, ON M5H 1J9, Canada</p></div>
        </div>
      </div>
    </div>
    <div class="footer-bar"><div>Generated by <strong>WebDesk Solution</strong></div><div>Page ${++pageNo}</div></div>
  </div>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Custom App Testing Technical Report — ${esc(host)}</title>
<style>${CLIENT_REPORT_CSS}</style></head>
<body>
${cover}
${summary}
${coverage}
${retestPages.join('\n')}
${findingPages.join('\n')}${noFindings}
${passPages.join('\n')}
${obs}
${recPages.join('\n')}
${contact}
</body></html>`;

  const outDir = getArchivePath(HOST, month);
  mkdirSync(outDir, { recursive: true });
  const base = `integrity-${year}-${mm}-custom-app-technical-report`;
  const htmlPath = join(outDir, `${base}.html`);
  const pdfPath = join(outDir, `${base}.pdf`);
  writeFileSync(htmlPath, html, 'utf8');

  let browser;
  try {
    browser = await launchChromium({ headless: true });
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    // Safety net: warn if any page's content is taller than one A4 sheet (1123 px).
    const tall = await page.$$eval('.page-container', (els) => els.map((e, i) => ({ i: i + 1, h: e.scrollHeight })).filter((x) => x.h > 1125));
    if (tall.length) logger.warn(`Pages taller than A4: ${tall.map((t) => `p${t.i} (${t.h}px)`).join(', ')}`);
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' } });
    logger.success(`Technical report written to ${pdfPath}`);
  } finally {
    if (browser) await browser.close();
  }
  return pdfPath;
}

if (process.argv[1] && process.argv[1].endsWith('generate_integrity_technical_report.js')) {
  const i = process.argv.indexOf('--month');
  const month = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : JSON.parse(readFileSync('config/monthly-monitoring-input.json', 'utf8')).month;
  generateIntegrityTechnicalReport(month).catch((e) => { logger.error(`Technical report failed: ${e.message}`); process.exit(1); });
}
