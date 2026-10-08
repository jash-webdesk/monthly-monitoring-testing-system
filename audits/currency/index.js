import { runCurrency } from '../../runners/currency.runner.js';
import { save } from '../_shared.js';

export const meta = { category: 'currency', runners: ['currency'], description: 'USD/CAD storefront price recalculation (guest session, never checkout).' };

export async function run(ctx) {
  if (!Array.isArray(ctx.siteConfig.currencies) || !ctx.siteConfig.currencies.includes('CAD')) {
    return { status: 'skipped', reason: 'Site has no multi-currency configuration.', runners: [], findings: [], metrics: {} };
  }
  const r = await runCurrency(ctx.url, ctx.siteConfig);
  save(ctx, 'currency', r);
  return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
}
