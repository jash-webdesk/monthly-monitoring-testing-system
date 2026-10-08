import { saveResults } from '../lib/archive.js';
import { logger } from '../lib/logger.js';

/** Runs `fn(url)` for each configured page and merges findings (ids/titles prefixed by page) and metrics. */
export async function runPerPage(ctx, fn) {
  const pages = ctx.siteConfig.pages ?? { homepage: ctx.url };
  const findings = [];
  const metricsByPage = {};
  for (const [pageType, pageUrl] of Object.entries(pages)) {
    logger.info(`  [${pageType}] ${pageUrl}`);
    const r = await fn(pageUrl);
    findings.push(...(r.findings ?? []).map((f) => ({
      ...f, id: `${f.id}-${pageType}`, evidence: `[Page: ${pageType}] ${f.evidence}`, title: `[${pageType.toUpperCase()}] ${f.title}`
    })));
    metricsByPage[pageType] = r.metrics;
  }
  return { findings, metricsByPage, pages };
}

/** Combined result in the legacy shape the report generators read (homepage metrics at root, per-page under .pages). */
export function combine(ctx, runner, { findings, metricsByPage, pages }) {
  const primary = metricsByPage.homepage ?? metricsByPage[Object.keys(pages)[0]];
  return {
    runner, url: ctx.url, timestamp: new Date().toISOString(), status: 'completed',
    findings, metrics: { ...primary, pages: metricsByPage }
  };
}

export function save(ctx, runnerName, result) { saveResults(ctx.hostname, runnerName, result, ctx.month); }

export const notImplemented = (reason) => ({ status: 'not_implemented', reason, runners: [], findings: [], metrics: {} });
