import { join } from 'node:path';
import { runResponsive } from '../../runners/storefront.runner.js';
import { getArchivePath } from '../../lib/archive.js';
import { save } from '../_shared.js';

export const meta = { category: 'responsive', runners: ['responsive'], description: 'Desktop, tablet and phone layouts: screenshots, sideways scrolling and the phone menu.' };

export async function run(ctx) {
  const cfg = ctx.siteConfig.storefront;
  if (!cfg) return { status: 'skipped', reason: 'Site has no storefront configuration.', runners: [], findings: [], metrics: {} };
  const r = await runResponsive(ctx.url, cfg, join(getArchivePath(ctx.hostname, ctx.month), 'evidence'));
  save(ctx, 'responsive', r);
  return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
}
