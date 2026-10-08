/**
 * Shared definitions for the Integrity Reforestation custom-app coverage: the five areas
 * that are tested, and how a finding id maps back to its area. Used by both the client deck
 * (generate_tree_widget_report.js) and the technical report (generate_integrity_technical_report.js).
 */
export const CUSTOM_APP_HOST = 'integrity-reforestation';
export const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export const CUSTOM_APP_AREAS = [
  { key: 'dashboard', label: 'Dashboard', pages: ['login', 'dashboard'], tested: 'Summary cards, 30-day charts, Top 5 Contributors, Recent Contributions (paging, page size, Refresh), totals cross-checked against Stores Listing' },
  { key: 'stores', label: 'Stores Listing', pages: ['stores'], tested: 'Columns, search, Status and Plan filters, page size and paging, date range, layout at 1280 / 1440 / 1920 px' },
  { key: 'storeDetail', label: 'Store Detail (View)', pages: ['storeDetail'], tested: 'View on every store: sections, name/plan/trees/contribution vs list, Install History, Financial Breakdown buttons' },
  { key: 'emails', label: 'Email Templates', pages: ['emails'], tested: 'Columns, expected template codes, statuses, keyword search, empty state, paging (read-only)' },
  { key: 'emailLogs', label: 'Email Logs', pages: ['emailLogs'], tested: 'Columns, recipients, status filter (Sent/Failed), search, paging, date range calendar, row View details' }
];

/** Maps a finding to one of CUSTOM_APP_AREAS' keys (or 'general'). */
export function areaOfFinding(f) {
  const id = f?.id ?? '';
  if (id.startsWith('integrity-stores-')) return 'stores';
  if (id.startsWith('integrity-detail-')) return 'storeDetail';
  if (id.startsWith('integrity-dashboard-')) return 'dashboard';
  if (id.startsWith('integrity-emails-')) return 'emails';
  if (id.startsWith('integrity-logs-') || id.startsWith('integrity-emailLogs-')) return 'emailLogs';
  return 'general';
}

/** Per-area totals from a saved integrity_dashboard result: checks run, passed, items noted. */
export function summarizeCustomApp(result) {
  const checks = result.metrics?.checks ?? [];
  const tally = result.metrics?.tally ?? {};
  const findings = [...(result.findings ?? [])]
    .filter((f) => !f.id.includes('runner-error') && f.severity !== 'info')
    .sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));
  const areas = CUSTOM_APP_AREAS.map((a) => {
    const t = a.pages.reduce((acc, p) => { const x = tally[p] ?? {}; acc.pass += x.pass ?? 0; acc.fail += (x.fail ?? 0) + (x.error ?? 0); return acc; }, { pass: 0, fail: 0 });
    return { ...a, run: t.pass + t.fail, passed: t.pass, items: findings.filter((f) => areaOfFinding(f) === a.key).length };
  });
  const run = checks.filter((c) => c.status !== 'skip').length;
  const passed = checks.filter((c) => c.status === 'pass').length;
  return {
    testedOn: result.timestamp, run, passed, failed: run - passed, findings, areas,
    writes: (result.metrics?.blockedWrites ?? []).length,
    latestFailed: result.metrics?.emailLogs?.latestFailed ?? null,
    daysSinceFailed: result.metrics?.emailLogs?.daysSinceLatestFailure ?? null,
    storesChecked: result.metrics?.stores?.detailPagesChecked ?? null
  };
}

/** What the dev team said they fixed (their note of Oct 7, 2026), keyed by the finding id it relates to. */
export const DEV_FIX_NOTES = {
  'integrity-stores-plan-filter-missing-option': 'Professional plan now included dynamically in the Stores filter',
  'integrity-stores-status-filter-label': 'Inactive filter now handles inactive and uninstalled stores',
  'integrity-emailLogs-calendar-clipped': 'Email Logs calendar popover kept within the screen',
  'integrity-stores-view-button-clipped': 'Responsive dashboard layout for tablet and mobile',
  'integrity-stores-truncated-headers': 'Responsive dashboard layout for tablet and mobile',
  'integrity-dashboard-truncated-headers': 'Responsive dashboard layout for tablet and mobile'
};

/**
 * Compares a current run against the pre-fix baseline (integrity_dashboard_baseline_pre-fix.json).
 * @returns {null|{baselineDate:string, baselineCount:number, rows:Object[], fixed:number, open:number, newCount:number}}
 */
export function compareWithBaseline(current, baselineResult) {
  if (!baselineResult) return null;
  const base = summarizeCustomApp(baselineResult).findings;
  const nowIds = new Set(current.findings.map((f) => f.id));
  const baseIds = new Set(base.map((f) => f.id));
  const rows = base.map((f) => ({ id: f.id, title: f.title, severity: f.severity, area: areaOfFinding(f), fixed: !nowIds.has(f.id), devNote: DEV_FIX_NOTES[f.id] ?? '' }));
  return {
    baselineDate: baselineResult.timestamp, baselineCount: base.length, rows,
    fixed: rows.filter((r) => r.fixed).length, open: rows.filter((r) => !r.fixed).length,
    newCount: current.findings.filter((f) => !baseIds.has(f.id)).length
  };
}
