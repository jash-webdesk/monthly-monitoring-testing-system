import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCustomApp } from '../../runners/customapp.runner.js';
import { runIntegrityDashboard } from '../../runners/integrityDashboard.runner.js';
import { repoRoot } from '../../lib/config.js';
import { save } from '../_shared.js';

export const meta = { category: 'companion-app', runners: ['customapp', 'integrity_dashboard'], description: 'Authenticated, read-only QA of the project companion app. Every non-GET request after login is blocked and reported critical.' };

export async function run(ctx) {
  const sc = ctx.siteConfig;
  if (sc.companionApp?.kind === 'integrity-dashboard') {
    const cfg = JSON.parse(readFileSync(join(repoRoot(), sc.companionApp.configFile), 'utf8'));
    const r = await runIntegrityDashboard(cfg, ctx.month);
    save(ctx, 'integrity_dashboard', r);
    return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
  }
  if (sc.customApp?.enabled) {
    const r = await runCustomApp(sc, ctx.hostname, ctx.month);
    save(ctx, 'customapp', r);
    return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
  }
  return { status: 'skipped', reason: 'Site has no companion app.', runners: [], findings: [], metrics: {} };
}
