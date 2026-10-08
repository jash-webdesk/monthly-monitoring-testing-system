import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, loadKnownIssues } from '../lib/config.js';
import { diffFindings, buildDiffSummary } from '../lib/differ.js';
import { getPreviousMonthStr } from '../lib/archive.js';
import { flattenScores } from './scores.js';

const SCHEMA_VERSION = 1;
const HISTORY_DIR = () => join(repoRoot(), 'history');

export const historyPath = (projectId, month) => join(HISTORY_DIR(), projectId, `${month}.json`);

export function loadHistory(projectId, month) {
  const p = historyPath(projectId, month);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** Latest stored month strictly before `month`, or null. */
export function loadPreviousHistory(projectId, month) {
  const dir = join(HISTORY_DIR(), projectId);
  if (!existsSync(dir)) return null;
  const months = readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 7)).filter((m) => m < month).sort();
  return months.length ? loadHistory(projectId, months[months.length - 1]) : null;
}

const compactFinding = (f) => ({
  id: f.id, runner: f.runner, category: f.category, severity: f.severity, title: f.title,
  detail: String(f.detail ?? '').slice(0, 400), evidence: String(f.evidence ?? '').slice(0, 300), recommendation: String(f.recommendation ?? '').slice(0, 300)
});

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Small set of numeric metrics worth trending, taken from the raw audit results. Missing values are skipped. */
export function keyMetrics(audits) {
  const m = {};
  const perf = audits.performance?.metrics;
  for (const [page, pm] of Object.entries(perf?.pages ?? {})) {
    for (const vp of ['desktop', 'mobile']) {
      const x = pm?.[vp];
      for (const k of ['score', 'lcp', 'cls', 'tbt', 'fcp']) { const v = num(x?.[k]); if (v != null) m[`performance.${page}.${vp}.${k === 'score' ? 'measuredScore' : k}`] = v; }
    }
  }
  const cert = audits.ssl?.metrics?.certificate;
  if (cert?.validTo) m['ssl.daysRemaining'] = Math.floor((new Date(cert.validTo).getTime() - Date.now()) / 86400000);
  const net = audits.network?.metrics;
  if (num(net?.uptimePercentage) != null) m['network.uptimePercentage'] = net.uptimePercentage;
  if (num(net?.responseTimeMs) != null) m['network.responseTimeMs'] = net.responseTimeMs;
  return m;
}

// Direction in which a metric is "good". Unknown metrics are reported as changes only.
const HIGHER_BETTER = /(measuredScore|daysRemaining|uptimePercentage|\.before|\.after)$/;
const LOWER_BETTER = /\.(lcp|cls|tbt|fcp|responseTimeMs)$|findings\./;

function compareMetrics(cur, prev) {
  const out = { changes: [], regressions: [], improvements: [] };
  for (const [k, v] of Object.entries(cur)) {
    if (!(k in prev) || prev[k] === v) continue;
    const delta = Math.round((v - prev[k]) * 1000) / 1000;
    const row = { metric: k, previous: prev[k], current: v, delta };
    out.changes.push(row);
    const better = HIGHER_BETTER.test(k) ? delta > 0 : LOWER_BETTER.test(k) ? delta < 0 : null;
    if (better === true) out.improvements.push(row);
    else if (better === false) out.regressions.push(row);
  }
  return out;
}

const bySeverity = (fs) => fs.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] ?? 0) + 1 }), {});

/**
 * Builds the normalized monthly record from per-site audit outcomes.
 * @param {Object} p
 * @param {Object} p.project project config
 * @param {string} p.month YYYY-MM
 * @param {Object<string,{url:string,audits:Object}>} p.siteRuns outcomes keyed by hostname; audits[category] = { status, reason?, error?, durationMs, findings, metrics }
 * @param {Object|null} p.scores canonical scores keyed by hostname -> pages (see engine/scores.js)
 */
export function buildRecord({ project, month, siteRuns, scores }) {
  const prevHistory = loadPreviousHistory(project.id, month);
  const prevMonth = prevHistory?.month ?? getPreviousMonthStr(month);
  const sites = {};
  const comparison = { previousMonth: prevHistory?.month ?? null, hasPreviousData: Boolean(prevHistory), sites: {} };

  for (const [hostname, run] of Object.entries(siteRuns)) {
    const auditSummary = {};
    const findings = [];
    for (const [cat, a] of Object.entries(run.audits)) {
      auditSummary[cat] = { status: a.status, durationMs: a.durationMs ?? null, findingCount: a.findings?.length ?? 0, ...(a.reason ? { reason: a.reason } : {}), ...(a.error ? { error: a.error } : {}), ...(a.note ? { note: a.note } : {}) };
      if (a.status === 'completed') findings.push(...(a.findings ?? []).filter((f) => !String(f.id).includes('runner-error')));
    }
    // seo and ai-crawlers share crawler findings; keep one copy per id for the diff.
    const unique = [...new Map(findings.map((f) => [f.id, f])).values()];
    const metrics = keyMetrics(Object.fromEntries(Object.entries(run.audits).map(([c, a]) => [c, a.status === 'completed' ? { metrics: a.metrics } : {}]).map(([c, v]) => [c, v.metrics ? v : {}])));
    const sevCounts = bySeverity(unique);
    for (const s of ['critical', 'high', 'medium', 'low']) metrics[`findings.${s}`] = sevCounts[s] ?? 0;

    const prevSite = prevHistory?.sites?.[hostname];
    const prevFindings = prevSite?.findings ?? [];
    const diffed = diffFindings(unique, prevFindings, loadKnownIssues(hostname), prevMonth);
    const summary = buildDiffSummary(diffed);
    const statusById = new Map(diffed.map((d) => [d.id, d]));
    sites[hostname] = {
      url: run.url,
      audits: auditSummary,
      metrics,
      findings: unique.map((f) => ({ ...compactFinding(f), status: statusById.get(f.id)?.status ?? 'new', openSince: statusById.get(f.id)?.openSince ?? month })),
      resolved: diffed.filter((d) => d.status === 'resolved').map(compactFinding)
    };
    comparison.sites[hostname] = {
      findings: summary,
      ...(prevSite ? compareMetrics(metrics, prevSite.metrics ?? {}) : { changes: [], regressions: [], improvements: [] })
    };
  }

  const scoreRows = {};
  const prevScores = prevHistory?.scores ?? {};
  for (const [host, pages] of Object.entries(scores ?? {})) {
    scoreRows[host] = flattenScores(pages);
    const prevRows = prevScores[host] ?? [];
    for (const row of scoreRows[host]) {
      const p = prevRows.find((r) => r.page === row.page && r.viewport === row.viewport);
      row.previousAfter = p?.after ?? null;
      row.changeVsPreviousMonth = p ? row.after - p.after : null;
    }
    const cmp = comparison.sites[host] ?? (comparison.sites[host] = { findings: null, changes: [], regressions: [], improvements: [] });
    for (const row of scoreRows[host]) {
      if (row.changeVsPreviousMonth == null || row.changeVsPreviousMonth === 0) continue;
      const entry = { metric: `score.${row.page}.${row.viewport}.after`, previous: row.previousAfter, current: row.after, delta: row.changeVsPreviousMonth };
      cmp.changes.push(entry);
      (entry.delta > 0 ? cmp.improvements : cmp.regressions).push(entry);
    }
  }

  return { schemaVersion: SCHEMA_VERSION, project: project.id, month, generatedAt: new Date().toISOString(), scores: scoreRows, sites, comparison };
}

export function saveHistory(record) {
  const p = historyPath(record.project, record.month);
  mkdirSync(join(HISTORY_DIR(), record.project), { recursive: true });
  // A partial run must not erase sites audited earlier in the same month.
  const existing = loadHistory(record.project, record.month);
  if (existing) {
    record = { ...record, sites: { ...existing.sites, ...record.sites }, scores: { ...existing.scores, ...record.scores }, comparison: { ...record.comparison, sites: { ...existing.comparison?.sites, ...record.comparison.sites } } };
  }
  writeFileSync(p, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return p;
}
