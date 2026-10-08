#!/usr/bin/env node
/**
 * Monthly Monitoring audit orchestrator (one engine, per-project config).
 *
 *   node engine/run-audit.js --url https://genpet.org --month 2026-10 \
 *     --scores "Homepage Mobile 68>74, Desktop 79>83; About Us Mobile 71>77, Desktop 82>87" \
 *     --outputs technical,client
 *
 * Flags: --url | --project <id> [--all-sites] | --month YYYY-MM | --scores "<text>" | --scores-json '<json>' | --scores-file <path>
 *        --outputs technical,client | --only a,b | --skip a,b | --stage before|after | --reports-only | --dry-run | --no-history
 *        --timeout-min <n> (per audit, default 25)
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installNetwork } from '../lib/net.js';
import { logger } from '../lib/logger.js';
import { getProject, setRuntimeOverrides, getSiteConfig, repoRoot } from '../lib/config.js';
import { saveRawResults, saveDiffResults, loadPreviousRawFindings, getPreviousMonthStr, getArchivePath } from '../lib/archive.js';
import { diffFindings, buildDiffSummary } from '../lib/differ.js';
import { loadKnownIssues } from '../lib/config.js';
import { AUDITS, CATEGORIES } from '../audits/index.js';
import { identifyProject } from './identify.js';
import { parseScores, scoresForHost, toLegacyScores } from './scores.js';
import { buildRecord, saveHistory, historyPath } from './history.js';
import { generateReports, normalizeOutputs } from './reports.js';

function loadDotEnv() {
  const p = resolve(repoRoot(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('--')) { a[k] = v; i++; } else a[k] = true;
  }
  return a;
}

const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} exceeded ${Math.round(ms / 60000)} minute timeout`)), ms); timer.unref?.(); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function auditEnabled(project, audit, hostname, only, skip) {
  const cfg = project.audits?.[audit.category] ?? {};
  if (only.length && !only.includes(audit.category)) return { run: false, status: 'skipped', reason: 'Not selected with --only.' };
  if (skip.includes(audit.category)) return { run: false, status: 'skipped', reason: 'Excluded with --skip.' };
  if (cfg.enabled === false) return { run: false, status: 'disabled', reason: cfg.reason ?? 'Disabled in the project configuration.' };
  if (Array.isArray(cfg.appliesTo) && !cfg.appliesTo.includes(hostname)) return { run: false, status: 'skipped', reason: `Does not apply to ${hostname}.` };
  return { run: true };
}

async function runSite({ project, site, url, month, stage, only, skip, timeoutMs }) {
  const hostname = site?.hostname ?? new URL(url).hostname;
  const siteConfig = getSiteConfig(hostname);
  const ctx = { project, hostname, url, month, stage, siteConfig, shared: {} };
  const audits = {};
  const runnerResults = [];

  for (const audit of AUDITS) {
    const gate = auditEnabled(project, audit, hostname, only, skip);
    if (!gate.run) { audits[audit.category] = { status: gate.status, reason: gate.reason, findings: [], metrics: {} }; continue; }
    logger.info(`> ${audit.category}: ${audit.description}`);
    const started = Date.now();
    try {
      const out = await withTimeout(audit.run(ctx), timeoutMs, audit.category);
      audits[audit.category] = { ...out, durationMs: Date.now() - started };
      if (out.status === 'completed') {
        runnerResults.push(...(out.runners ?? []).filter((r) => stage !== 'before' || r.runner !== 'lighthouse'));
        logger.success(`  ${audit.category}: ${out.findings.length} finding(s)`);
      } else logger.info(`  ${audit.category}: ${out.status}${out.reason ? ' - ' + out.reason : ''}`);
    } catch (err) {
      audits[audit.category] = { status: 'failed', error: err.message, findings: [], metrics: {}, durationMs: Date.now() - started };
      logger.runnerError(audit.category, err.message);
    }
  }

  // Legacy archive files (raw.json + month-over-month diff) keep the existing report generators working.
  if (runnerResults.length) {
    try {
      saveRawResults(hostname, runnerResults, month);
      const current = runnerResults.flatMap((r) => r.findings ?? []).filter((f) => !String(f.id).includes('runner-error'));
      const previous = loadPreviousRawFindings(hostname, month);
      const prevMonth = getPreviousMonthStr(month);
      const diffed = diffFindings(current, previous, loadKnownIssues(hostname), prevMonth);
      saveDiffResults(hostname, { month, previousMonth: prevMonth, hasPreviousData: previous.length > 0, summary: buildDiffSummary(diffed), findings: diffed }, month);
    } catch (err) { logger.warn(`Legacy archive step failed: ${err.message}`); }
  }
  return { hostname, url, audits };
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  await installNetwork();

  const month = typeof args.month === 'string' ? args.month : new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Invalid --month "${month}" (expected YYYY-MM)`);
  const stage = args.stage === 'before' ? 'before' : 'after';
  const only = csv(args.only);
  const skip = csv(args.skip);
  for (const c of [...only, ...skip]) if (!CATEGORIES.includes(c)) throw new Error(`Unknown audit "${c}". Valid: ${CATEGORIES.join(', ')}`);

  // 1. Project identification
  let project, targets;
  if (typeof args.project === 'string') {
    project = getProject(args.project);
    if (!project) throw new Error(`Unknown project "${args.project}"`);
    targets = project.sites.map((s) => ({ site: s, url: typeof args.url === 'string' && args['all-sites'] !== true ? identifyProject(args.url).url : (s.pages?.homepage ?? `https://${s.hostname}/`) }));
    if (typeof args.url === 'string' && !args['all-sites']) targets = targets.filter((t) => new URL(t.url).hostname.replace(/^www\./, '') === t.site.hostname.replace(/^www\./, ''));
  } else {
    if (typeof args.url !== 'string') throw new Error('Missing --url (or --project <id>). Example: --url https://genpet.org --month 2026-10');
    const id = identifyProject(args.url);
    project = id.project;
    targets = args['all-sites'] ? project.sites.map((s) => ({ site: s, url: s.pages?.homepage ?? `https://${s.hostname}/` })) : [{ site: id.site ?? { hostname: id.hostname }, url: id.url }];
  }

  const outputs = normalizeOutputs(csv(args.outputs));
  const scoresRule = project.inputs?.performanceScores ?? 'required';
  let parsed = { byHost: {}, shared: null };
  if (typeof args['scores-file'] === 'string') parsed = parseScores(readFileSync(resolve(args['scores-file']), 'utf8'));
  else if (typeof args['scores-json'] === 'string') parsed = parseScores(args['scores-json']);
  else if (typeof args.scores === 'string') parsed = parseScores(args.scores);

  logger.section(`Monthly Monitoring: ${project.name} - ${month}`);
  logger.info(`Context: ${project.context ?? 'n/a'}`);
  const missingScores = [];
  const legacyOverrideHosts = [];
  for (const { site, url } of targets) {
    const host = site.hostname;
    const pages = scoresForHost(parsed, host);
    if (scoresRule === 'not-applicable') {
      if (pages) logger.warn(`Scores were supplied but ${project.name} does not use PageSpeed Before/After scores; ignoring them.`);
    } else if (!pages) {
      missingScores.push(host);
    } else {
      setRuntimeOverrides(host, { scores: toLegacyScores(pages) });
      legacyOverrideHosts.push(host);
    }
  }

  // Before/After scores are mandatory for scored projects whenever reports are requested or the performance audit runs.
  const perfRuns = targets.some((t) => auditEnabled(project, AUDITS.find((x) => x.category === 'performance'), t.site.hostname, only, skip).run);
  const scoresRequired = scoresRule === 'required' && stage !== 'before' && !args['reports-only'] ? (outputs.length > 0 || perfRuns) : scoresRule === 'required' && outputs.length > 0;
  if (scoresRequired && missingScores.length && !args['dry-run']) {
    throw new Error(`Before/After performance scores are required for ${project.name} and were not supplied for: ${missingScores.join(', ')}. Provide them for every page and viewport you tested, for example --scores "Homepage Mobile 68>74, Desktop 79>83; About Us Mobile 71>77, Desktop 82>87". Nothing was run.`);
  }

  if (args['dry-run']) {
    const plan = {
      project: project.id, month, stage, sites: targets.map((t) => t.site.hostname), outputs,
      performanceScores: scoresRule, scoresMissingFor: missingScores, scoresRequired,
      audits: Object.fromEntries(AUDITS.map((a) => [a.category, targets.map((t) => { const g = auditEnabled(project, a, t.site.hostname, only, skip); return g.run ? 'run' : `${g.status}: ${g.reason}`; })[0]])),
      requiredEnv: (project.secrets ?? []).map((s) => ({ env: s.env, required: s.required, present: Boolean(process.env[s.env]) })),
      inputs: project.inputs
    };
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const summary = { project: project.id, month, stage, startedAt: new Date().toISOString(), sites: {}, reports: {}, history: null, warnings: [] };

  // 2. Audits (isolated per audit; one failure never stops the rest)
  const siteRuns = {};
  if (!args['reports-only']) {
    const timeoutMs = (Number(args['timeout-min']) || 25) * 60000;
    for (const t of targets) {
      logger.section(`Auditing ${t.site.hostname}`);
      siteRuns[t.site.hostname] = await runSite({ project, site: t.site, url: t.url, month, stage, only, skip, timeoutMs });
    }
  }

  // 4. Normalize and persist history (month-over-month)
  if (!args['reports-only'] && !args['no-history'] && stage !== 'before') {
    const scoreMap = {};
    for (const host of legacyOverrideHosts) scoreMap[host] = scoresForHost(parsed, host);
    const record = buildRecord({ project, month, siteRuns, scores: scoreMap });
    summary.history = historyPath(project.id, month).replace(repoRoot() + '\\', '').replace(repoRoot() + '/', '').replace(/\\/g, '/');
    saveHistory(record);
    summary.comparison = record.comparison;
  }

  // 5. Reports
  if (outputs.length && stage !== 'before') {
    logger.section('Report generation');
    for (const t of targets) {
      // Integrity has one client deck per project; generate it once.
      summary.reports[t.site.hostname] = await generateReports({ project, hostname: t.site.hostname, month, outputs });
      if (project.reports?.client === 'integrity-deck') break;
    }
  }

  for (const [host, run] of Object.entries(siteRuns)) {
    summary.sites[host] = Object.fromEntries(Object.entries(run.audits).map(([c, a]) => [c, { status: a.status, findings: a.findings?.length ?? 0, ...(a.reason ? { reason: a.reason } : {}), ...(a.error ? { error: a.error } : {}) }]));
  }
  summary.finishedAt = new Date().toISOString();
  const out = join(getArchivePath(project.id, month), 'run-summary.json');
  mkdirSync(getArchivePath(project.id, month), { recursive: true });
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log('\n===== RUN SUMMARY =====');
  console.log(JSON.stringify(summary, null, 2));

  const anyOk = Object.values(siteRuns).some((r) => Object.values(r.audits).some((a) => a.status === 'completed'));
  if (!args['reports-only'] && !anyOk) process.exit(1);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((err) => { logger.error(err.message); process.exit(1); });
