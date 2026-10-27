import { join } from 'node:path';
import { notImplemented } from '../_shared.js';
import { runJourneys } from '../../runners/storefront.runner.js';
import { getArchivePath } from '../../lib/archive.js';
import { save } from '../_shared.js';

export const meta = { category: 'functional', runners: ['functional'], description: 'Customer journeys on the live store: search, product, add to cart, quantity, coupon check, checkout screen (not submitted), remove, sign-in messages.' };

export async function run(ctx) {
  const cfg = ctx.siteConfig.storefront;
  if (!cfg) return notImplemented('This site has no storefront configuration, so no customer journeys are defined for it.');
  const r = await runJourneys(ctx.url, cfg, join(getArchivePath(ctx.hostname, ctx.month), 'evidence'));
  save(ctx, 'functional', r);
  return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
}
