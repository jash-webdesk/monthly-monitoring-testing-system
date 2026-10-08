import {
  writeFileSync, readFileSync, mkdirSync,
  existsSync, readdirSync, statSync
} from 'node:fs';
import { resolve, join } from 'node:path';

const RESULTS_DIR = resolve(process.cwd(), 'results');

/**
 * Returns the current month in YYYY-MM format.
 * @returns {string}
 */
function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Returns the previous month in YYYY-MM format, relative to a reference month.
 * Defaults to relative to the current system month if no reference is given.
 *
 * Pure string/integer arithmetic — deliberately avoids `new Date(y, m, 1).toISOString()`,
 * which round-trips through UTC and rolls the 1st of the month back a day in any
 * timezone behind UTC, silently pointing at the wrong month.
 *
 * @param {string} [refMonth] - YYYY-MM. Defaults to the current month.
 * @returns {string}
 */
function previousMonth(refMonth = null) {
  const [y, m] = (refMonth ?? currentMonth()).split('-').map(Number);
  let year = y;
  let month = m - 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Public helper — returns the month immediately before the given month.
 * Used by the report generator and orchestrator so both derive "previous month"
 * the same way, relative to the run being processed rather than the system clock.
 *
 * @param {string} month - YYYY-MM
 * @returns {string} YYYY-MM
 */
export function getPreviousMonthStr(month) {
  return previousMonth(month);
}

/**
 * Returns the archive directory path for a hostname and month.
 *
 * @param {string} hostname - e.g. "partsconnexion.com"
 * @param {string} [month]  - YYYY-MM. Defaults to current month.
 * @returns {string} Absolute directory path
 */
export function getArchivePath(hostname, month = null) {
  return join(RESULTS_DIR, hostname, month ?? currentMonth());
}

/**
 * Saves a runner result to the monthly results archive.
 * Creates directories if they do not exist.
 * Overwrites existing file for the same runner and month.
 *
 * @param {string} hostname - e.g. "partsconnexion.com"
 * @param {string} runner   - Runner name, used as filename prefix
 * @param {Object} result   - Runner result from createRunnerResult()
 * @param {string} [month]  - YYYY-MM. Defaults to current month.
 */
export function saveResults(hostname, runner, result, month = null) {
  const dir = getArchivePath(hostname, month);
  mkdirSync(dir, { recursive: true });
  const filepath = join(dir, `${runner}_result.json`);
  writeFileSync(filepath, JSON.stringify(result, null, 2), 'utf8');
}

/**
 * Loads a runner result from the archive.
 * Returns null if not found or if JSON is corrupted.
 *
 * @param {string} hostname
 * @param {string} runner
 * @param {string} [month]  - YYYY-MM. Defaults to current month.
 * @returns {Object|null}
 */
export function loadResults(hostname, runner, month = null) {
  const dir  = getArchivePath(hostname, month);
  const path = join(dir, `${runner}_result.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Loads last month's runner result for month-over-month comparison.
 * Returns null if no previous results exist.
 *
 * @param {string} hostname
 * @param {string} runner
 * @param {string} [refMonth] - YYYY-MM run month to compare against. Defaults to the current month.
 * @returns {Object|null}
 */
export function loadPreviousResults(hostname, runner, refMonth = null) {
  return loadResults(hostname, runner, previousMonth(refMonth));
}

/**
 * Loads last month's combined raw.json and flattens every runner's findings
 * into a single array, for use as the "previous findings" input to diffFindings().
 * Returns an empty array if no previous raw.json exists (first monitored month).
 *
 * @param {string} hostname
 * @param {string} [refMonth] - YYYY-MM run month to compare against. Defaults to the current month.
 * @returns {Object[]}
 */
export function loadPreviousRawFindings(hostname, refMonth = null) {
  const prevMonth = previousMonth(refMonth);
  const dir  = getArchivePath(hostname, prevMonth);
  const path = join(dir, 'raw.json');
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return (raw.runners ?? []).flatMap(r => r.findings ?? []);
  } catch {
    return [];
  }
}

/**
 * Saves the month-over-month findings diff (new/persisting/resolved/suppressed)
 * to the results archive for inspection and audit trail purposes.
 *
 * @param {string} hostname
 * @param {Object} diffPayload - { month, previousMonth, hasPreviousData, summary, findings }
 * @param {string} [month] - YYYY-MM. Defaults to current month.
 */
export function saveDiffResults(hostname, diffPayload, month = null) {
  const dir = getArchivePath(hostname, month);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'diff_result.json'), JSON.stringify(diffPayload, null, 2), 'utf8');
}

/**
 * Lists all months that have archived results for a hostname.
 * Returns months sorted in descending order (most recent first).
 *
 * @param {string} hostname
 * @returns {string[]} Array of YYYY-MM strings
 */
export function listMonths(hostname) {
  const hostDir = join(RESULTS_DIR, hostname);
  if (!existsSync(hostDir)) return [];
  return readdirSync(hostDir)
    .filter(d => /^\d{4}-\d{2}$/.test(d) && statSync(join(hostDir, d)).isDirectory())
    .sort()
    .reverse();
}

/**
 * Saves a merged raw.json combining all runner results for the month.
 * Called by the orchestrator after all runners have completed.
 *
 * @param {string}   hostname
 * @param {Object[]} allResults - Array of runner result objects
 * @param {string}  [month]
 */
export function saveRawResults(hostname, allResults, month = null) {
  const dir = getArchivePath(hostname, month);
  mkdirSync(dir, { recursive: true });
  const rawPath = join(dir, 'raw.json');

  // Merge with any existing raw.json for this month rather than overwriting wholesale —
  // a partial run (e.g. `--phase ssl` to re-check one thing mid-month) must not silently
  // discard every other runner's results already archived for this month.
  let existingRunners = [];
  if (existsSync(rawPath)) {
    try {
      existingRunners = JSON.parse(readFileSync(rawPath, 'utf8')).runners ?? [];
    } catch {
      existingRunners = [];
    }
  }
  const newRunnerNames = new Set(allResults.map(r => r.runner));
  const mergedRunners = [
    ...existingRunners.filter(r => !newRunnerNames.has(r.runner)),
    ...allResults
  ];

  const payload = {
    hostname,
    month:     month ?? currentMonth(),
    createdAt: new Date().toISOString(),
    runners:   mergedRunners
  };
  writeFileSync(rawPath, JSON.stringify(payload, null, 2), 'utf8');
}
