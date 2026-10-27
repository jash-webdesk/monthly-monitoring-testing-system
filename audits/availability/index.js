import { runAvailability } from '../../runners/storefront.runner.js';
import { save } from '../_shared.js';

export const meta = { category: 'availability', runners: ['availability'], description: 'Every page linked from the header, menus and footer: loads, redirects, response time buckets and the "not found" page.' };

export async function run(ctx) {
  const cfg = ctx.siteConfig.storefront;
  if (!cfg) return { status: 'skipped', reason: 'Site has no storefront configuration.', runners: [], findings: [], metrics: {} };
  const r = await runAvailability(ctx.url, cfg);
  ctx.shared.navLinks = r.metrics.pages.map((p) => p.url);
  ctx.shared.availability = r;
  save(ctx, 'availability', r);
  return { status: 'completed', runners: [r], findings: r.findings, metrics: { ...r.metrics, pages: undefined } };
}
