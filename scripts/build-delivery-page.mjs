#!/usr/bin/env node
/**
 * Builds a self-contained HTML page for the Claude Artifact tool: audit status, month-over-month summary, and the
 * finished report files embedded in the page with a Save button each (uses the artifact "downloads" capability).
 *
 *   node scripts/build-delivery-page.mjs --project genpet --month 2026-10 --out <file.html> [--label "TEST"]
 *
 * Publish the result with the Artifact tool and capabilities {downloads: true}. Reports above the size budget are
 * listed without an embedded copy (use the GitHub link instead). Nothing here is sent anywhere.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
const projectId = arg('project'), month = arg('month'), out = arg('out'), label = arg('label');
if (!projectId || !/^\d{4}-\d{2}$/.test(month ?? '') || !out) { console.error('Usage: --project <id> --month YYYY-MM --out <file.html> [--label TEXT]'); process.exit(1); }

const BUDGET = 12 * 1024 * 1024; // raw bytes; base64 adds a third and the page limit is 16 MB
const dir = join(root, 'reports', projectId, month);
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(pdf|pptx)$/i.test(f) && !/_v2\.pptx$/i.test(f)) : [];
let used = 0;
const embedded = files.map((f) => {
  const size = statSync(join(dir, f)).size;
  const mime = f.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const fits = used + size <= BUDGET;
  if (fits) used += size;
  return { name: f, size, mime, kind: f.endsWith('.pdf') ? 'Technical report (PDF)' : 'Client report (PowerPoint)', b64: fits ? readFileSync(join(dir, f)).toString('base64') : null };
});

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const history = readJson(join(root, 'history', projectId, `${month}.json`));
const summary = readJson(join(root, 'results', projectId, month, 'run-summary.json'));

const sites = Object.entries(history?.sites ?? {}).map(([host, s]) => ({
  host,
  audits: Object.entries(s.audits).map(([c, a]) => ({ c, status: a.status, n: a.findingCount ?? 0, note: a.reason ?? a.error ?? '' })),
  findings: s.findings.length,
  sev: s.findings.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] ?? 0) + 1 }), {}),
  cmp: history.comparison?.sites?.[host] ?? null
}));

const data = { project: projectId, month, label, generatedAt: history?.generatedAt ?? summary?.finishedAt ?? null, previousMonth: history?.comparison?.previousMonth ?? null, sites, warnings: summary?.warnings ?? [], files: embedded.map(({ name, size, mime, kind, b64 }) => ({ name, size, mime, kind, b64 })) };

const esc = (s) => String(s).replace(/</g, '\\u003c');
const html = readFileSync(join(root, 'scripts', 'delivery-page.template.html'), 'utf8').replace('/*__DATA__*/null', esc(JSON.stringify(data)));
writeFileSync(out, html);
console.log(`Wrote ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB, ${embedded.filter((f) => f.b64).length}/${embedded.length} files embedded)`);
