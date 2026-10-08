import { runUptime } from '../../runners/uptime.runner.js';
import { save } from '../_shared.js';

export const meta = { category: 'network', runners: ['uptime'], description: 'Availability and response time (UptimeRobot 30-day when UPTIMEROBOT_API_KEY is set, live probe otherwise).' };

export async function run(ctx) {
  const r = await runUptime(ctx.url);
  save(ctx, 'uptime', r);
  return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
}
