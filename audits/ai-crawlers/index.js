import { runCrawler } from '../../runners/crawler.runner.js';
import { save } from '../_shared.js';

export const meta = { category: 'ai-crawlers', runners: ['crawler'], description: 'robots.txt access for AI crawlers (GPTBot, Gemini, Claude, Perplexity). Shares the crawl with the seo audit.' };

const AI = /gptbot|gemini|claudebot|perplexity|ai (web )?crawler|llms?\.txt/i;

export async function run(ctx) {
  let r = ctx.shared.crawler;
  if (!r) {
    r = await runCrawler(ctx.url);
    ctx.shared.crawler = r;
    save(ctx, 'crawler', r);
    save(ctx, 'crawl_audit', r);
  }
  const findings = (r.findings ?? []).filter((f) => AI.test(`${f.title} ${f.detail} ${f.id}`));
  return { status: 'completed', runners: [], findings, metrics: { aiCrawlerFindings: findings.length }, note: 'Derived from the crawler result; these findings are also counted under seo.' };
}
