import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repoRoot, getSiteConfig } from '../lib/config.js';
import { getArchivePath, loadResults, getPreviousMonthStr } from '../lib/archive.js';
import { logger } from '../lib/logger.js';

/** Output vocabulary accepted by --outputs. */
export const OUTPUT_TYPES = ['technical', 'client', 'deck'];
// "deck" is an alias of "client" (the client PowerPoint).

export function normalizeOutputs(list) {
  const out = new Set();
  for (const raw of list) {
    const t = raw.trim().toLowerCase().replace(/\s+report$/, '').replace(/[\s_]+/g, '-');
    if (['technical', 'tech'].includes(t)) out.add('technical');
    else if (['client', 'client-pptx', 'client-ppt', 'deck', 'pptx', 'ppt'].includes(t)) out.add('client');
    else if (t) throw new Error(`Unknown output type "${raw}". Use: technical, client`);
  }
  return [...out];
}

/** Falls back to measured PageSpeed results when no manual scores were supplied for a site. */
function legacyScoresFromMeasured(hostname, month) {
  const cur = loadResults(hostname, 'lighthouse', month);
  if (!cur?.metrics?.desktop && !cur?.metrics?.mobile) return null;
  const prev = loadResults(hostname, 'lighthouse', getPreviousMonthStr(month));
  const before = loadResults(hostname, 'lighthouse_before', month) ?? prev;
  const out = {};
  for (const vp of ['desktop', 'mobile']) {
    const a = cur.metrics?.[vp]?.score;
    if (a == null) continue;
    out[vp] = { before: { performance: before?.metrics?.[vp]?.score ?? a }, after: { performance: a } };
  }
  return out;
}

export function hasScores(hostname) { return Boolean(getSiteConfig(hostname).scores); }
export { legacyScoresFromMeasured };

async function siteReports({ hostname, month, want }) {
  const made = [];
  if (want.includes('technical')) {
    const { generateClientReport } = await import('../report/generator.js');
    made.push(await generateClientReport(hostname, month, { skipPpt: true }));
  }
  if (want.includes('client')) {
    const { generatePptReport } = await import('../generate_ppt_report.js');
    made.push(await generatePptReport(hostname, month, {}));
  }
  return made;
}

async function integrityReports({ project, hostname, month, want }) {
  const made = [];
  if (want.includes('technical')) {
    const { generateIntegrityTechnicalReport } = await import('../generate_integrity_technical_report.js');
    made.push(await generateIntegrityTechnicalReport(month));
  }
  if (want.includes('client')) {
    const input = resolve(repoRoot(), (project.reportMeta?.monthlyInputPattern ?? 'config/monthly-monitoring-input-{month}.json').replace('{month}', month));
    if (!existsSync(input)) {
      throw new Error(`The client deck needs ${input}. It holds the theme update log, widget screenshot links and dev-team notes for the month. Copy the previous month's file and update it, then re-run with --reports-only.`);
    }
    try {
      execFileSync(process.execPath, [join(repoRoot(), 'scripts', 'validate-integrity-input.mjs'), '--month', month], { encoding: 'utf8' });
    } catch (e) {
      throw new Error(`The Integrity input file failed validation:\n${e.stdout ?? e.message}`);
    }
    const { generateTreeWidgetReport } = await import('../generate_tree_widget_report.js');
    const r = await generateTreeWidgetReport(input, 'both');
    made.push(...Object.values(r));
  }
  return made;
}

/**
 * Generates the requested reports for one site and copies the finished files to reports/<project>/<month>/.
 * @returns {Promise<{ outputs: string[], copied: string[], errors: string[] }>}
 */
export async function generateReports({ project, hostname, month, outputs }) {
  const want = normalizeOutputs(outputs);
  const startedAt = Date.now() - 2000;
  const errors = [];
  const isIntegrity = project.reports?.client === 'integrity-deck';
  try {
    if (isIntegrity) await integrityReports({ project, hostname, month, want });
    else await siteReports({ hostname, month, want });
  } catch (err) {
    errors.push(err.message);
    logger.error(`Report generation failed for ${hostname}: ${err.message}`);
  }

  // Collect pdf/pptx files written during this step from the archive folders.
  const dirs = new Set([getArchivePath(hostname, month), getArchivePath(project.id, month)]);
  const dest = join(repoRoot(), 'reports', project.id, month);
  const copied = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.(pdf|pptx)$/i.test(f)) continue;
      const p = join(dir, f);
      if (statSync(p).mtimeMs < startedAt) continue;
      mkdirSync(dest, { recursive: true });
      copyFileSync(p, join(dest, f));
      copied.push(join('reports', project.id, month, f).replace(/\\/g, '/'));
    }
  }
  return { outputs: want, copied, errors };
}
