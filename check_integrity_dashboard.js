import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './lib/logger.js';
import { saveResults } from './lib/archive.js';
import { runIntegrityDashboard } from './runners/integrityDashboard.runner.js';

/**
 * Standalone entry for the read-only Integrity Reforestation dashboard coverage.
 * Usage: node check_integrity_dashboard.js [--month YYYY-MM]   (default: the cycle month in config/monthly-monitoring-input.json)
 * Saves results/integrity-reforestation/<month>/integrity_dashboard_result.json
 */
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

const argv = process.argv.slice(2);
const mi = argv.indexOf('--month');
const month = mi !== -1 && argv[mi + 1] ? argv[mi + 1] : new Date().toISOString().slice(0, 7);
if (!/^\d{4}-\d{2}$/.test(month)) { logger.error(`Invalid --month "${month}" (expected YYYY-MM)`); process.exit(1); }

const config = JSON.parse(readFileSync('config/integrity-dashboard.json', 'utf8'));
logger.info(`Integrity dashboard read-only coverage (${month})`);
const result = await runIntegrityDashboard(config, month);
saveResults(config.hostname, 'integrity_dashboard', result, month);

const t = result.metrics.tally ?? {};
for (const [page, c] of Object.entries(t)) logger.info(`  ${page.padEnd(12)} pass ${c.pass}  fail ${c.fail}  error ${c.error}  skip ${c.skip}`);
for (const f of result.findings) logger.warn(`  [${f.severity.toUpperCase()}] ${f.title}`);
logger.success(`Saved ${result.findings.length} finding(s).`);
