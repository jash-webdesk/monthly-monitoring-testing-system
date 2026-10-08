import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCustomApp } from '../../runners/customapp.runner.js';
import { runIntegrityDashboard } from '../../runners/integrityDashboard.runner.js';
import { repoRoot } from '../../lib/config.js';
import { save } from '../_shared.js';

export const meta = { category: 'companion-app', runners: ['customapp', 'integrity_dashboard'], description: 'Authenticated, read-only QA of the project companion app. Every non-GET request after login is blocked and reported critical.' };

const missingEnv = (auth) => [auth?.usernameEnvVar, auth?.passwordEnvVar].filter((n) => n && !process.env[n]);

export async function run(ctx) {
  const sc = ctx.siteConfig;
  if (sc.companionApp?.kind === 'integrity-dashboard') {
    const cfg = JSON.parse(readFileSync(join(repoRoot(), sc.companionApp.configFile), 'utf8'));
    const missing = missingEnv(cfg.auth);
    // The whole dashboard audit is behind the login, so without it there is nothing to run.
    if (missing.length) return { status: 'skipped', reason: `No login provided (${missing.join(', ')} not set). The dashboard checks need an account; nothing was run.`, runners: [], findings: [], metrics: {} };
    const r = await runIntegrityDashboard(cfg, ctx.month);
    save(ctx, 'integrity_dashboard', r);
    return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics };
  }
  if (sc.customApp?.enabled) {
    const missing = missingEnv(sc.customApp.auth);
    const r = await runCustomApp(sc, ctx.hostname, ctx.month);
    save(ctx, 'customapp', r);
    // Without a login the runner still does the unauthenticated reachability, SSL and DNS checks of the app.
    return { status: 'completed', runners: [r], findings: r.findings, metrics: r.metrics, ...(missing.length ? { note: `No login provided (${missing.join(', ')} not set): ran the unauthenticated health check only.` } : {}) };
  }
  return { status: 'skipped', reason: 'Site has no companion app.', runners: [], findings: [], metrics: {} };
}
