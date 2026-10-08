import { runLighthouse } from '../../runners/lighthouse.runner.js';
import { runPerPage, combine, save } from '../_shared.js';

export const meta = { category: 'performance', runners: ['lighthouse'], description: 'PageSpeed Insights (Core Web Vitals, median of 3) per configured page, mobile and desktop.' };

export async function run(ctx) {
  const key = ctx.stage === 'before' ? 'lighthouse_before' : 'lighthouse';
  const merged = await runPerPage(ctx, runLighthouse);
  const result = combine(ctx, key, merged);
  save(ctx, key, result);
  return { status: 'completed', runners: [result], findings: ctx.stage === 'before' ? [] : result.findings, metrics: result.metrics };
}
