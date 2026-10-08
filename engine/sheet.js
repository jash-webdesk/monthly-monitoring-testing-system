/**
 * Monthly inputs spreadsheet -> list of audit runs.
 *
 * Paste straight from Google Sheets or Excel (tab separated) or use a CSV. One header row, then one row per page:
 *
 *   Project | URL | Month | Page | Mobile Before | Mobile After | Desktop Before | Desktop After | Outputs | Dev Team Notes
 *
 * - Header names are case-insensitive and may be in any order. Project is optional (the URL identifies it).
 * - URL, Month, Outputs and Dev Team Notes fill down: leave them blank on following rows of the same site, like a merged cell.
 *   A new URL (or a new Month) starts a new run.
 * - Outputs: "technical", "client" or both, e.g. "technical, client".
 * - Projects without PageSpeed scores (Integrity Reforestation) need only URL, Month, Outputs and Dev Team Notes.
 * - Cells containing line breaks must be quoted, which Sheets and Excel do automatically when you copy.
 */

const HEADERS = {
  project: ['project', 'client'],
  url: ['url', 'website', 'website url', 'site', 'site url'],
  month: ['month', 'audit month'],
  page: ['page', 'page name'],
  mobileBefore: ['mobile before', 'mobile (before)', 'mobile before score'],
  mobileAfter: ['mobile after', 'mobile (after)', 'mobile after score'],
  desktopBefore: ['desktop before', 'desktop (before)', 'desktop before score'],
  desktopAfter: ['desktop after', 'desktop (after)', 'desktop after score'],
  outputs: ['outputs', 'output', 'generate', 'reports', 'report types'],
  devNotes: ['dev team notes', 'dev notes', 'dev team comment', 'dev team text', 'notes']
};

/** RFC 4180 style parser that also handles tab separators and quoted multi-line cells. */
export function parseDelimited(text) {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const firstLine = src.split('\n').find((l) => l.trim()) ?? '';
  const sep = firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

function columnMap(header) {
  const map = {};
  header.forEach((h, i) => {
    for (const [key, names] of Object.entries(HEADERS)) if (names.includes(norm(h)) && map[key] === undefined) map[key] = i;
  });
  return map;
}

const NUM = /^\d{1,3}$/;
const splitOutputs = (v) => String(v).split(/[,/&]|\band\b/i).map((x) => x.trim()).filter(Boolean);

/**
 * @param {string} text pasted sheet
 * @returns {{ runs: Object[], problems: string[] }}
 *   run = { project, url, month, outputs: string[], pages: [{page, mobile?:[b,a], desktop?:[b,a]}], scoresText, devNotes }
 */
export function parseSheet(text) {
  const rows = parseDelimited(text);
  const problems = [];
  if (rows.length < 2) return { runs: [], problems: ['The sheet needs a header row and at least one data row.'] };
  const col = columnMap(rows[0]);
  if (col.url === undefined) problems.push('No "URL" column found in the header row.');
  if (col.month === undefined) problems.push('No "Month" column found in the header row.');
  if (problems.length) return { runs: [], problems };

  const get = (r, k) => (col[k] === undefined ? '' : String(r[col[k]] ?? '').trim());
  const runs = [];
  let cur = null;
  let carry = { project: '', url: '', month: '', outputs: '', devNotes: '' };

  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const own = { project: get(r, 'project'), url: get(r, 'url'), month: get(r, 'month'), outputs: get(r, 'outputs'), devNotes: get(r, 'devNotes') };
    const startsNew = (own.url && own.url !== carry.url) || (own.month && own.month !== carry.month) || !cur;
    // Dev notes never fill down: they belong to the site they were typed on.
    for (const k of ['project', 'url', 'month', 'outputs']) if (own[k]) carry[k] = own[k];
    if (startsNew) {
      cur = { project: carry.project, url: carry.url, month: carry.month, outputs: splitOutputs(carry.outputs), pages: [], devNotes: '', line };
      runs.push(cur);
    }
    cur.project ||= carry.project;
    if (own.outputs) cur.outputs = splitOutputs(own.outputs);
    if (own.devNotes && !cur.devNotes) cur.devNotes = own.devNotes;

    const nums = { mb: get(r, 'mobileBefore'), ma: get(r, 'mobileAfter'), db: get(r, 'desktopBefore'), da: get(r, 'desktopAfter') };
    const page = get(r, 'page');
    if (Object.values(nums).some(Boolean) || page) {
      if (!page) problems.push(`Row ${line}: scores entered without a Page name.`);
      const entry = { page };
      for (const [vp, b, a] of [['mobile', 'mb', 'ma'], ['desktop', 'db', 'da']]) {
        if (!nums[b] && !nums[a]) continue;
        if (!nums[b] || !nums[a]) { problems.push(`Row ${line}: ${page || 'page'} ${vp} needs both Before and After.`); continue; }
        if (!NUM.test(nums[b]) || !NUM.test(nums[a]) || Number(nums[b]) > 100 || Number(nums[a]) > 100) { problems.push(`Row ${line}: ${page || 'page'} ${vp} scores must be whole numbers from 0 to 100.`); continue; }
        entry[vp] = [Number(nums[b]), Number(nums[a])];
      }
      if (page && !entry.mobile && !entry.desktop) problems.push(`Row ${line}: page "${page}" has no scores.`);
      if (page && (entry.mobile || entry.desktop)) cur.pages.push(entry);
    }
  });

  for (const run of runs) {
    if (!run.url) problems.push(`Row ${run.line}: missing URL.`);
    if (!/^\d{4}-\d{2}$/.test(normalizeMonth(run.month))) problems.push(`Row ${run.line}: month "${run.month}" is not understood (use 2026-10 or October 2026).`);
    run.month = normalizeMonth(run.month);
    if (!run.outputs.length) run.outputs = ['technical', 'client'];
    run.scoresText = run.pages.map((p) => `${p.page} ${['mobile', 'desktop'].filter((v) => p[v]).map((v) => `${v[0].toUpperCase()}${v.slice(1)} ${p[v][0]}>${p[v][1]}`).join(', ')}`).join('; ');
  }
  return { runs, problems };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "2026-10", "10/2026", "October 2026" -> "2026-10"; anything else is returned unchanged. */
export function normalizeMonth(s) {
  const t = String(s).trim();
  if (/^\d{4}-\d{2}$/.test(t)) return t;
  let m = t.match(/^(\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = t.match(/^([a-z]+)\.?\s+(\d{4})$/i);
  if (m) {
    const i = MONTHS.findIndex((n) => n.startsWith(m[1].toLowerCase().slice(0, 3)));
    if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, '0')}`;
  }
  return t;
}
