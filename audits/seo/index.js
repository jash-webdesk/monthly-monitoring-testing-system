import { runCrawler } from '../../runners/crawler.runner.js';
import { runSeoSample } from '../../runners/storefront.runner.js';
import { save } from '../_shared.js';

export const meta = { category: 'seo', runners: ['crawler'], description: 'Sitemap and crawl, canonicals, robots.txt, structured data, AEO/GEO readiness, multi-viewport layout.' };

export async function run(ctx) {
  const r = await runCrawler(ctx.url);
  ctx.shared.crawler = r;
  save(ctx, 'crawler', r);
  save(ctx, 'crawl_audit', r);
  // Sites with a storefront block also get a sampled-page check (titles, descriptions, headings, canonical, sharing tags).
  const cfg = ctx.siteConfig.storefront;
  if (cfg) {
    const sample = await runSeoSample(ctx.url, cfg, ctx.shared.navLinks ?? []);
    save(ctx, 'seo_sample', sample);
    return { status: 'completed', runners: [r, sample], findings: [...r.findings, ...sample.findings], metrics: { ...r.metrics, sample: sample.metrics } };
  }
  return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
}
