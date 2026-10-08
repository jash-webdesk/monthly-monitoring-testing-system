import { runSsl } from '../../runners/ssl.runner.js';
import { save } from '../_shared.js';

export const meta = { category: 'ssl', runners: ['ssl'], description: 'Certificate validity and expiry, issuer, chain. Reads the certificate through the browser when raw TLS is blocked.' };

export async function run(ctx) {
  const r = await runSsl(ctx.url);
  save(ctx, 'ssl', r);
  return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
}
