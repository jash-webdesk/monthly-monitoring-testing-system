#!/usr/bin/env node
/**
 * Validates config/monthly-monitoring-input-<month>.json before the Integrity client deck is generated.
 *   node scripts/validate-integrity-input.mjs --month 2026-10
 * Exit 1 on errors. Warnings (stale carry-over from the previous month) do not fail the run but must be reviewed.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const i = process.argv.indexOf('--month');
const month = i > -1 ? process.argv[i + 1] : null;
if (!/^\d{4}-\d{2}$/.test(month ?? '')) { console.error('Usage: node scripts/validate-integrity-input.mjs --month YYYY-MM'); process.exit(1); }

const file = join(root, 'config', `monthly-monitoring-input-${month}.json`);
if (!existsSync(file)) { console.error(`ERROR missing ${file}`); process.exit(1); }
const data = JSON.parse(readFileSync(file, 'utf8'));

const errors = [];
const warnings = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };
const isUrl = (u) => { try { return /^https:/.test(new URL(u).protocol + ''); } catch { return false; } };

need(data.month === month, `"month" is "${data.month}", expected "${month}"`);
for (const k of ['reportTitle', 'clientName', 'storeUrl', 'executiveSummary', 'opsMonitoringSection', 'qaTestingSection']) need(data[k], `missing "${k}"`);

const o = data.opsMonitoringSection ?? {};
for (const k of ['overview', 'performanceMetrics', 'sslSecurity', 'buildCacheAnalysis', 'last24HoursUsage', 'incidents', 'overallSummary', 'finalAssessment']) need(o[k], `opsMonitoringSection.${k} is missing`);
for (const env of ['app', 'dashboard']) {
  const pm = o.performanceMetrics?.[env];
  need(pm?.responseTime && pm?.memoryUsage && pm?.throughput, `performanceMetrics.${env} needs responseTime, memoryUsage and throughput`);
  need(isUrl(pm?.referenceUrl), `performanceMetrics.${env}.referenceUrl must be an https URL`);
  need(isUrl(o.buildCacheAnalysis?.[env]?.beforeUrl) && isUrl(o.buildCacheAnalysis?.[env]?.afterUrl), `buildCacheAnalysis.${env} needs beforeUrl and afterUrl (https)`);
  need(isUrl(o.last24HoursUsage?.[env]?.evidenceUrl), `last24HoursUsage.${env}.evidenceUrl must be an https URL`);
}
const ssl = o.sslSecurity ?? {};
need(ssl.commonName && ssl.issuer && /^\d{4}-\d{2}-\d{2}$/.test(ssl.issuedOn ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(ssl.expiresOn ?? ''), 'sslSecurity needs commonName, issuer, issuedOn and expiresOn (YYYY-MM-DD)');
if (ssl.expiresOn && new Date(ssl.expiresOn) < new Date()) errors.push(`SSL certificate expiry ${ssl.expiresOn} is in the past`);
if (ssl.screenshot && !existsSync(join(root, 'results', 'integrity-reforestation', month, ssl.screenshot)) && !existsSync(join(root, ssl.screenshot))) warnings.push(`SSL screenshot "${ssl.screenshot}" not found; the slide will render without the image`);
for (const [n, inc] of (o.incidents ?? []).entries()) need(inc.title && inc.issue && inc.rootCause && inc.resolutionSteps?.length, `incidents[${n}] needs title, issue, rootCause and resolutionSteps`);

// Stale carry-over check: evidence URLs and metrics identical to the previous month's file are suspicious.
const prevFile = readdirSync(join(root, 'config'))
  .map((f) => ({ f, m: f.match(/^monthly-monitoring-input(?:-(\d{4}-\d{2}))?\.json$/)?.[1] }))
  .filter((x) => x.m && x.m < month).sort((a, b) => a.m.localeCompare(b.m)).pop();
if (prevFile) {
  const urls = (d) => new Set(JSON.stringify(d.opsMonitoringSection ?? {}).match(/https:\/\/[^"\s]+/g) ?? []);
  const prev = urls(JSON.parse(readFileSync(join(root, 'config', prevFile.f), 'utf8')));
  const same = [...urls(data)].filter((u) => prev.has(u));
  if (same.length) warnings.push(`${same.length} evidence URL(s) are identical to ${prevFile.m}'s file (stale carry-over?): ${same.slice(0, 3).join(', ')}${same.length > 3 ? ' ...' : ''}`);
}

for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(errors.length ? `\n${errors.length} error(s). Fix the input file before generating the deck.` : `\nInput file for ${month} is valid${warnings.length ? ` (${warnings.length} warning(s) to review)` : ''}.`);
process.exit(errors.length ? 1 : 0);
