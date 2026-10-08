import { runDns } from '../../runners/dns.runner.js';
import { save } from '../_shared.js';

export const meta = { category: 'dns', runners: ['dns'], description: 'NS, MX, SPF, DMARC and address records. Uses DNS-over-HTTPS when raw DNS is blocked.' };

export async function run(ctx) {
  const r = await runDns(ctx.hostname);
  save(ctx, 'dns', r);
  return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
}
