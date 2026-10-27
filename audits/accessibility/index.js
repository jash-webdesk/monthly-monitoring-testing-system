import { runAccessibility } from '../../runners/storefront.runner.js';
import { save } from '../_shared.js';

export const meta = { category: 'accessibility', runners: ['accessibility'], description: 'Basic automated accessibility checks (axe, WCAG 2 A and AA) on the home, product, cart and sign-in pages.' };

export async function run(ctx) {
  const cfg = ctx.siteConfig.storefront;
  if (!cfg) return { status: 'skipped', reason: 'Site has no storefront configuration.', runners: [], findings: [], metrics: {} };
  const r = await runAccessibility(ctx.url, cfg);
  save(ctx, 'accessibility', r);
  return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
}
