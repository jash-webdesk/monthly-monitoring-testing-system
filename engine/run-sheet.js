#!/usr/bin/env node
/**
 * Runs the monthly audits described by a pasted spreadsheet (see engine/sheet.js for the format).
 *
 *   node engine/run-sheet.js --file inputs/2026-10-sheet.tsv [--dry-run] [--only a,b]
 *
 * One audit per site/month row group, run one after another. Each run is the normal engine
 * (node engine/run-audit.js ...), so every rule there applies: mandatory scores, per-site logins, guest fallback.
 * The sheet is stored under inputs/<month>/ and any dev team notes under config/dev-notes/ as the month's record.
 * Prints a JSON summary of every run at the end and exits non-zero if any run failed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSheet } from './sheet.js';
import { identifyProject } from './identify.js';
import { repoRoot } from '../lib/config.js';
import { normalizeOutputs } from './reports.js';

const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf('--' + k); return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const file = flag('file');
if (typeof file !== 'string') { console.error('Usage: node engine/run-sheet.js --file <sheet.tsv> [--dry-run] [--only a,b]'); process.exit(1); }

const text = readFileSync(resolve(file), 'utf8');
const { runs, problems } = parseSheet(text);

// Resolve each run's project early so unknown sites are reported together with the other problems.
for (const run of runs) {
  try {
    const id = identifyProject(run.url);
    run.projectId = id.project.id;
    run.projectName = id.project.name;
    run.scoresRule = id.project.inputs?.performanceScores ?? 'required';
    run.host = id.hostname;
    if (run.scoresRule === 'required' && !run.pages.length) problems.push(`Row ${run.line}: ${id.project.name} (${run.url}) needs Before/After scores for at least one page.`);
    if (run.scoresRule === 'not-applicable' && run.pages.length) problems.push(`Row ${run.line}: ${id.project.name} does not use PageSpeed scores; remove the Page and score cells.`);
    if (run.scoresRule === 'not-applicable' && run.outputs.includes('client') && !run.devNotes) problems.push(`Row ${run.line}: ${id.project.name} client deck needs the Dev Team Notes text.`);
    try { normalizeOutputs(run.outputs); } catch (e) { problems.push(`Row ${run.line}: ${e.message}`); }
  } catch (e) { problems.push(`Row ${run.line}: ${e.message}`); }
}

const plan = runs.map((r) => ({ project: r.projectName ?? r.project, url: r.url, month: r.month, outputs: r.outputs, scores: r.scoresText || '(none)', devNotes: r.devNotes ? `${r.devNotes.length} characters` : '(none)' }));
console.log(JSON.stringify({ runs: plan, problems }, null, 2));
if (problems.length) { console.error(`\n${problems.length} problem(s) in the sheet. Nothing was run.`); process.exit(2); }
if (flag('dry-run')) process.exit(0);

// Keep the inputs with the month's record.
const months = [...new Set(runs.map((r) => r.month))];
for (const m of months) {
  const dir = join(repoRoot(), 'inputs', m);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sheet.tsv'), text);
}
for (const r of runs) {
  if (!r.devNotes) continue;
  const dir = join(repoRoot(), 'config', 'dev-notes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${r.projectId}-${r.month}.txt`), r.devNotes + '\n');
}

const results = [];
for (const r of runs) {
  const args = [join(repoRoot(), 'engine', 'run-audit.js'), '--url', r.url, '--month', r.month, '--outputs', r.outputs.join(',')];
  if (r.scoresText) args.push('--scores', r.scoresText);
  const only = flag('only');
  if (typeof only === 'string') args.push('--only', only);
  console.log(`\n===== ${r.projectName ?? r.project}  ${r.url}  ${r.month} =====`);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: repoRoot() });
  const needsInput = r.scoresRule === 'not-applicable' && r.outputs.includes('client') && !existsSync(join(repoRoot(), 'config', `monthly-monitoring-input-${r.month}.json`));
  results.push({ project: r.projectId, url: r.url, month: r.month, exitCode: res.status, seconds: Math.round((Date.now() - t0) / 1000), ...(needsInput ? { action: `Build config/monthly-monitoring-input-${r.month}.json from config/dev-notes/${r.projectId}-${r.month}.txt (see CLAUDE.md), validate it, then re-run with --reports-only.` } : {}) });
}
console.log('\n===== SHEET SUMMARY =====');
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((x) => x.exitCode !== 0) ? 1 : 0);
