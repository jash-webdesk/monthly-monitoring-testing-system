import { STATUS } from './result.js';

/**
 * Compares current run findings to last month's findings and assigns lifecycle statuses.
 *
 * Rules (from AGENTS.md):
 *   ID in current, not in previous  → NEW
 *   ID in both current and previous → PERSISTING (with openSince)
 *   ID in previous, not in current  → RESOLVED
 *   ID in known-issues.json         → SUPPRESSED
 *
 * @param {Object[]} currentFindings   - Findings from current run (status: 'new')
 * @param {Object[]} [previousFindings] - Findings from last month's archive
 * @param {Object[]} [knownIssues]      - Site-specific known-issues entries
 * @param {string}   [previousMonth]   - YYYY-MM — used to stamp openSince on persisting findings
 * @returns {Object[]} Findings with updated statuses, plus resolved items appended
 */
export function diffFindings(currentFindings, previousFindings = [], knownIssues = [], previousMonth = null) {
  const prevMap      = new Map((previousFindings ?? []).map(f => [f.id, f]));
  const suppressIds  = new Set((knownIssues ?? []).map(ki => ki.id));
  const output       = [];

  // ── Process current findings ───────────────────────────────────
  for (const finding of currentFindings) {
    const updated = { ...finding };

    if (suppressIds.has(finding.id)) {
      // Confirmed false positive — suppress regardless of history
      updated.status = STATUS.SUPPRESSED;

    } else if (prevMap.has(finding.id)) {
      // Existed last month — mark as persisting and carry forward openSince
      const prev        = prevMap.get(finding.id);
      updated.status    = STATUS.PERSISTING;
      updated.openSince = prev.openSince ?? previousMonth ?? 'unknown';

    } else {
      // First time we've seen this finding
      updated.status = STATUS.NEW;
    }

    output.push(updated);
  }

  // ── Add RESOLVED findings ──────────────────────────────────────
  // These existed last month but are not in the current run.
  const currentIds = new Set(currentFindings.map(f => f.id));
  for (const prev of (previousFindings ?? [])) {
    if (!currentIds.has(prev.id) && prev.status !== STATUS.RESOLVED) {
      output.push({ ...prev, status: STATUS.RESOLVED });
    }
  }

  return output;
}

/**
 * Compares performance scores between current and previous run.
 * Returns null if no previous month data exists (first run).
 *
 * Drift direction:
 *   > +2 points → 'up'   (improvement)
 *   < -2 points → 'down' (regression)
 *   within ±2   → 'same' (noise, not significant)
 *
 * @param {Object}      currentMetrics  - Metrics from the current Lighthouse run
 * @param {Object|null} previousMetrics - Metrics from the previous month, or null
 * @returns {Object|null} Score drift comparison, or null on first run
 */
export function diffScores(currentMetrics, previousMetrics) {
  if (!previousMetrics) return null;

  const compare = (device) => {
    const cur  = currentMetrics?.[device]?.score ?? null;
    const prev = previousMetrics?.[device]?.score ?? null;
    if (cur === null || prev === null) return null;
    const drift = cur - prev;
    return {
      current:   cur,
      previous:  prev,
      drift,
      direction: drift > 2 ? 'up' : drift < -2 ? 'down' : 'same'
    };
  };

  return {
    desktop: compare('desktop'),
    mobile:  compare('mobile')
  };
}

/**
 * Builds a human-readable diff summary for the console/report header.
 *
 * @param {Object[]} findings - Diffed findings array
 * @returns {{ new: number, persisting: number, resolved: number, suppressed: number }}
 */
export function buildDiffSummary(findings) {
  const counts = { new: 0, persisting: 0, resolved: 0, suppressed: 0 };
  for (const f of findings) {
    if (f.status in counts) counts[f.status]++;
  }
  return counts;
}
