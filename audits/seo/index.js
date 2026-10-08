import { runCrawler } from '../../runners/crawler.runner.js';
import { save } from '../_shared.js';

export const meta = { category: 'seo', runners: ['crawler'], description: 'Sitemap and crawl, canonicals, robots.txt, structured data, AEO/GEO readiness, multi-viewport layout.' };

export async function run(ctx) {
  const r = await runCrawler(ctx.url);
  ctx.shared.crawler = r;
  save(ctx, 'crawler', r);
  save(ctx, 'crawl_audit', r);
  return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
}
