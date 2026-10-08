import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runDns } from './runners/dns.runner.js';
import { runSsl } from './runners/ssl.runner.js';
import { runLighthouse } from './runners/lighthouse.runner.js';
import { runDevtools } from './runners/devtools.runner.js';
import { runUptime } from './runners/uptime.runner.js';
import { runCrawler } from './runners/crawler.runner.js';
import { runCustomApp } from './runners/customapp.runner.js';
import { runCurrency } from './runners/currency.runner.js';
import { generateClientReport } from './report/generator.js';
import {
  saveResults, saveRawResults, loadPreviousResults,
  loadPreviousRawFindings, saveDiffResults, getPreviousMonthStr
} from './lib/archive.js';
import { diffScores, diffFindings, buildDiffSummary } from './lib/differ.js';
import { logger } from './lib/logger.js';
import { getSiteConfig, loadKnownIssues } from './lib/config.js';

// Load .env file manually if it exists
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const firstEq = trimmed.indexOf('=');
    if (firstEq === -1) continue;
    const key = trimmed.slice(0, firstEq).trim().replace(/^['"]|['"]$/g, '');
    const value = trimmed.slice(firstEq + 1).trim().replace(/^['"]|['"]$/g, '');
    process.env[key] = value;
  }
}


/**
 * Main orchestrator for the Monthly Monitoring Testing System.
 */
async function main() {
  const args = process.argv.slice(2);
  const parsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const nextVal = args[i + 1];
      if (nextVal && !nextVal.startsWith('--')) {
        parsedArgs[key] = nextVal;
        i++;
      } else {
        parsedArgs[key] = true;
      }
    }
  }

  const urlStr = parsedArgs.url;
  if (!urlStr) {
    logger.error('Missing required argument: --url');
    console.log('Usage: node monitor.js --url <url> [--phase <phase>] [--stage before|after] [--month <YYYY-MM>] [--analyze-only] [--report-only]');
    process.exit(1);
  }

  let parsedUrl;
  try {
    let checkUrl = urlStr;
    if (!/^https?:\/\//i.test(urlStr)) {
      checkUrl = 'https://' + urlStr;
    }
    parsedUrl = new URL(checkUrl);
  } catch (err) {
    logger.error(`Invalid URL provided: "${urlStr}". Error: ${err.message}`);
    process.exit(1);
  }

  const hostname = parsedUrl.hostname;
  const fullUrl = parsedUrl.toString();
  const runMonth  = typeof parsedArgs.month === 'string' ? parsedArgs.month : null;
  const authFile   = typeof parsedArgs.auth  === 'string' ? parsedArgs.auth  : null;

  const siteConfig = getSiteConfig(hostname);
  const pages = siteConfig.pages || { homepage: fullUrl };

  if (runMonth && !/^\d{4}-\d{2}$/.test(runMonth)) {
    logger.error(`Invalid month format provided: "${runMonth}". Expected format: YYYY-MM (e.g. 2026-07)`);
    process.exit(1);
  }

  logger.section(`Monthly Monitoring Audit: ${hostname}`);
  logger.info(`Target URL: ${fullUrl}`);
  if (runMonth) {
    logger.info(`Target Month: ${runMonth}`);
  }

  if (parsedArgs['analyze-only']) {
    logger.warn('Flag --analyze-only was requested, but Phase 6 (AI Analysis) is not yet implemented.');
    process.exit(0);
  }

  // Handle isolated report generation (--report-only)
  if (parsedArgs['report-only']) {
    const prevDesktop = parsedArgs['prev-desktop'] ? parseInt(parsedArgs['prev-desktop']) : null;
    const prevMobile = parsedArgs['prev-mobile'] ? parseInt(parsedArgs['prev-mobile']) : null;
    const currDesktop = parsedArgs['curr-desktop'] ? parseInt(parsedArgs['curr-desktop']) : null;
    const currMobile = parsedArgs['curr-mobile'] ? parseInt(parsedArgs['curr-mobile']) : null;
    const runMonthVal = runMonth ?? new Date().toISOString().slice(0, 7);
    try {
      await generateClientReport(hostname, runMonthVal, { prevDesktop, prevMobile, currDesktop, currMobile });
      logger.success('Client PDF report generated in --report-only mode.');
    } catch (err) {
      logger.error(`Report generation failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  const phase = parsedArgs.phase;
  // Lighthouse capture stage: 'before' = baseline snapshot taken at the start of this
  // month's audit, prior to any optimization work; 'after' (default) = the canonical
  // current-month measurement, taken once fixes are done. Only 'after' feeds the client
  // report's finding list / month-over-month diff / auto report generation — 'before'
  // exists purely to give the report an accurate same-month baseline instead of reusing
  // last month's archived score.
  const stage = parsedArgs.stage === 'before' ? 'before' : 'after';
  if (parsedArgs.stage === 'before') {
    logger.info('Lighthouse stage: BEFORE (pre-optimization baseline — will not trigger report generation)');
  }
  const results = [];

  // Run Uptime phase
  if (!phase || phase === 'uptime') {
    try {
      const uptimeResult = await runUptime(fullUrl);
      saveResults(hostname, 'uptime', uptimeResult, runMonth);
      results.push(uptimeResult);
    } catch (err) {
      logger.runnerError('uptime', `Unexpected error in orchestrator: ${err.message}`);
    }
  }

  // Run DNS phase
  if (!phase || phase === 'dns') {
    try {
      const dnsResult = await runDns(hostname);
      saveResults(hostname, 'dns', dnsResult, runMonth);
      results.push(dnsResult);
    } catch (err) {
      logger.runnerError('dns', `Unexpected error in orchestrator: ${err.message}`);
    }
  }

  // Run Custom App phase — auto-detected via config/sites.json's customApp block.
  // Zero manual effort for sites without one (siteConfig.customApp is simply undefined).
  if ((!phase || phase === 'customapp') && siteConfig.customApp?.enabled) {
    try {
      logger.info('▶  Starting runner: customapp (companion app audit)');
      const customAppResult = await runCustomApp(siteConfig, hostname, runMonth);
      saveResults(hostname, 'customapp', customAppResult, runMonth);
      results.push(customAppResult);
      logger.success(`✓  Runner done: customapp — ${customAppResult.findings.length} finding(s)`);
    } catch (err) {
      logger.runnerError('customapp', `Unexpected error in orchestrator: ${err.message}`);
    }
  }

  // Run Currency phase — auto-detected via config/sites.json's currencies array.
  // Zero manual effort for sites without multi-currency (siteConfig.currencies is undefined).
  if ((!phase || phase === 'currency') && Array.isArray(siteConfig.currencies) && siteConfig.currencies.includes('CAD')) {
    try {
      logger.info('▶  Starting runner: currency (USD/CAD storefront verification)');
      const currencyResult = await runCurrency(fullUrl, siteConfig);
      saveResults(hostname, 'currency', currencyResult, runMonth);
      results.push(currencyResult);
      logger.success(`✓  Runner done: currency — ${currencyResult.findings.length} finding(s)`);
    } catch (err) {
      logger.runnerError('currency', `Unexpected error in orchestrator: ${err.message}`);
    }
  }

  // Run SSL phase
  if (!phase || phase === 'ssl') {
    try {
      const sslResult = await runSsl(fullUrl);
      saveResults(hostname, 'ssl', sslResult, runMonth);
      results.push(sslResult);
    } catch (err) {
      logger.runnerError('ssl', `Unexpected error in orchestrator: ${err.message}`);
    }
  }

  // Run Crawler / SEO phase (Pillar 4 SEO, Pillar 10 Crawl, Pillar 12 Responsive)
  if (!phase || phase === 'crawler' || phase === 'seo' || phase === 'crawl') {
    try {
      logger.info('▶  Starting runner: crawler (Pillar 4 SEO & Pillar 10 Crawl)');
      const crawlerResult = await runCrawler(fullUrl);
      saveResults(hostname, 'crawler', crawlerResult, runMonth);
      saveResults(hostname, 'crawl_audit', crawlerResult, runMonth);
      results.push(crawlerResult);
      logger.success(`✓  Runner done: crawler — ${crawlerResult.findings.length} finding(s)`);
    } catch (err) {
      logger.runnerError('crawler', `Unexpected error in orchestrator: ${err.message}`);
    }
  }

  // Run Lighthouse phase (desktop + mobile)
  if (!phase || phase === 'lighthouse') {
    try {
      const combinedFindings = [];
      const combinedMetrics = { hostname, url: fullUrl, pages: {} };

      for (const [pageType, pageUrl] of Object.entries(pages)) {
        logger.info(`Running Lighthouse for page: ${pageType} (${pageUrl})`);
        const lhResult = await runLighthouse(pageUrl);
        // Prefix finding IDs to prevent collisions
        const pageFindings = lhResult.findings.map(f => ({
          ...f,
          id: `${f.id}-${pageType}`,
          evidence: `[Page: ${pageType}] ${f.evidence}`,
          title: `[${pageType.toUpperCase()}] ${f.title}`
        }));
        combinedFindings.push(...pageFindings);
        combinedMetrics.pages[pageType] = lhResult.metrics;
      }

      const lhRunnerKey = stage === 'before' ? 'lighthouse_before' : 'lighthouse';
      const lhCombinedResult = {
        runner: lhRunnerKey,
        url: fullUrl,
        timestamp: new Date().toISOString(),
        status: 'completed',
        findings: combinedFindings,
        metrics: {
          ...combinedMetrics.pages.homepage, // Keep homepage metrics at root for report generator compatibility
          pages: combinedMetrics.pages       // Detailed metrics dictionary
        }
      };

      saveResults(hostname, lhRunnerKey, lhCombinedResult, runMonth);

      if (stage === 'before') {
        // Baseline snapshot only — does not feed findings/diff/report. The report reads
        // it back directly from lighthouse_before_result.json as the "Before" score.
        logger.success(`Before-optimization baseline captured for ${hostname} (${runMonth ?? new Date().toISOString().slice(0, 7)}).`);
      } else {
        results.push(lhCombinedResult);

        // Score drift — compare vs last month if previous results exist (use homepage as primary baseline).
        // Older archives store metrics flat (metrics.desktop/.mobile) rather than nested under
        // metrics.pages.<pageType> — fall back to the flat shape so real history isn't missed.
        const primaryLh = combinedMetrics.pages.homepage || combinedMetrics.pages[Object.keys(pages)[0]];
        const prevLh = loadPreviousResults(hostname, 'lighthouse', runMonth);
        const prevPrimary = prevLh?.metrics?.pages
          ? (prevLh.metrics.pages.homepage || prevLh.metrics.pages[Object.keys(prevLh.metrics.pages)[0]])
          : prevLh?.metrics;
        if (prevPrimary) {
          const drift = diffScores(primaryLh, prevPrimary);
          if (drift) {
            logger.info(`  Score drift (Homepage) — Desktop: ${drift.desktop?.direction ?? 'N/A'} (${drift.desktop?.previous ?? '?'} → ${drift.desktop?.current ?? '?'})`);
            logger.info(`  Score drift (Homepage) — Mobile:  ${drift.mobile?.direction  ?? 'N/A'} (${drift.mobile?.previous  ?? '?'} → ${drift.mobile?.current  ?? '?'})`);
          }
        } else {
          logger.info('  Score drift: N/A (first run — no previous month data)');
        }
      }
    } catch (err) {
      logger.runnerError('lighthouse', `Unexpected error in orchestrator: ${err.message}`);
    }
  }

  // Run Chrome DevTools / Browser phase (Playwright + CDP session)
  if (!phase || phase === 'devtools') {
    try {
      const combinedFindings = [];
      const combinedMetrics = { hostname, url: fullUrl, pages: {} };

      for (const [pageType, pageUrl] of Object.entries(pages)) {
        logger.info(`Running Chrome DevTools for page: ${pageType} (${pageUrl})`);
        const dtResult = await runDevtools(pageUrl, hostname, runMonth, authFile);
        const pageFindings = dtResult.findings.map(f => ({
          ...f,
          id: `${f.id}-${pageType}`,
          evidence: `[Page: ${pageType}] ${f.evidence}`,
          title: `[${pageType.toUpperCase()}] ${f.title}`
        }));
        combinedFindings.push(...pageFindings);
        combinedMetrics.pages[pageType] = dtResult.metrics;
      }

      const dtCombinedResult = {
        runner: 'devtools',
        url: fullUrl,
        timestamp: new Date().toISOString(),
        status: 'completed',
        findings: combinedFindings,
        metrics: {
          ...combinedMetrics.pages.homepage, // Keep homepage metrics at root
          pages: combinedMetrics.pages       // Detailed metrics dictionary
        }
      };

      saveResults(hostname, 'devtools', dtCombinedResult, runMonth);
      results.push(dtCombinedResult);
    } catch (err) {
      logger.runnerError('devtools', `Unexpected error in orchestrator: ${err.message}`);
    }
  }

  // Save raw.json combining all executed runners
  if (results.length > 0) {
    try {
      saveRawResults(hostname, results, runMonth);
      logger.success(`Runners completed. ${results.length} runner(s) saved to archive.`);
    } catch (err) {
      logger.error(`Failed to save combined raw results: ${err.message}`);
      process.exit(1);
    }

    // Month-over-month issue lifecycle: new / persisting / resolved / suppressed.
    // Compares this run's findings to last month's archived raw.json — no manual
    // input required. See lib/differ.js (Section 16 of the blueprint).
    try {
      const currentFindings = results
        .flatMap(r => r.findings || [])
        .filter(f => !f.id.includes('runner-error'));
      const previousFindings = loadPreviousRawFindings(hostname, runMonth);
      const knownIssues = loadKnownIssues(hostname);
      const prevMonthStr = getPreviousMonthStr(runMonth ?? new Date().toISOString().slice(0, 7));

      const diffedFindings = diffFindings(currentFindings, previousFindings, knownIssues, prevMonthStr);
      const diffSummary = buildDiffSummary(diffedFindings);
      const hasPreviousData = previousFindings.length > 0;

      logger.section('Month-Over-Month Issue Comparison');
      if (!hasPreviousData) {
        logger.info(`  No archived findings for ${prevMonthStr} — this is the first comparable run. All findings recorded as 'new'.`);
      } else {
        logger.info(`  Compared against: ${prevMonthStr}`);
      }
      logger.info(`  New: ${diffSummary.new}  |  Persisting: ${diffSummary.persisting}  |  Resolved: ${diffSummary.resolved}  |  Suppressed: ${diffSummary.suppressed}`);

      const persistingHighSeverity = diffedFindings.filter(
        f => f.status === 'persisting' && (f.severity === 'critical' || f.severity === 'high')
      );
      for (const f of persistingHighSeverity) {
        logger.warn(`  Persisting since ${f.openSince}: [${f.severity.toUpperCase()}] ${f.title}`);
      }

      saveDiffResults(hostname, {
        month: runMonth ?? new Date().toISOString().slice(0, 7),
        previousMonth: prevMonthStr,
        hasPreviousData,
        summary: diffSummary,
        findings: diffedFindings
      }, runMonth);
    } catch (err) {
      logger.warn(`Month-over-month comparison skipped: ${err.message}`);
    }
  } else {
    logger.warn('No runners were executed.');
  }

  // Generate PDF report automatically if we ran the full pipeline or specifically ran the lighthouse/report phase.
  // Never auto-generate off a 'before' baseline capture — that's a pre-optimization snapshot,
  // not the finished audit; the client report should only be built once the 'after' pass runs.
  if (stage !== 'before' && (!phase || phase === 'report' || phase === 'lighthouse' || phase === 'devtools' || phase === 'uptime' || phase === 'customapp' || phase === 'currency')) {
    logger.section('Report Generation Phase');
    const prevDesktop = parsedArgs['prev-desktop'] ? parseInt(parsedArgs['prev-desktop']) : null;
    const prevMobile = parsedArgs['prev-mobile'] ? parseInt(parsedArgs['prev-mobile']) : null;
    const currDesktop = parsedArgs['curr-desktop'] ? parseInt(parsedArgs['curr-desktop']) : null;
    const currMobile = parsedArgs['curr-mobile'] ? parseInt(parsedArgs['curr-mobile']) : null;
    const runMonthVal = runMonth ?? new Date().toISOString().slice(0, 7);
    try {
      await generateClientReport(hostname, runMonthVal, { prevDesktop, prevMobile, currDesktop, currMobile });
    } catch (err) {
      logger.error(`Failed to auto-generate PDF report: ${err.message}`);
    }
  }
}

main().catch((err) => {
  logger.error(`Fatal orchestrator error: ${err.message}`);
  process.exit(1);
});
