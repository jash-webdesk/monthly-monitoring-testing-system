/**
 * Standardised finding and result format for all runners.
 * Every runner must return findings matching this structure.
 * The analysis layer (Layer 2) depends on this contract.
 */

/** @enum {string} Valid severity levels */
export const SEVERITY = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low',
  INFO:     'info'
};

/** @enum {string} Valid finding categories */
export const CATEGORY = {
  PERFORMANCE:   'performance',
  SECURITY:      'security',
  ACCESSIBILITY: 'accessibility',
  FUNCTIONAL:    'functional',
  DNS:           'dns',
  SSL:           'ssl',
  UPTIME:        'uptime',
  CUSTOM_APP:    'custom_app'
};

/** @enum {string} Finding lifecycle statuses — set by differ.js, runners always use 'new' */
export const STATUS = {
  NEW:        'new',
  PERSISTING: 'persisting',
  RESOLVED:   'resolved',
  SUPPRESSED: 'suppressed'
};

const REQUIRED_FIELDS = ['id', 'runner', 'category', 'severity', 'title', 'detail', 'evidence', 'recommendation'];

/**
 * Creates a validated finding object.
 * Throws if any required field is missing or invalid.
 *
 * @param {Object} params
 * @param {string} params.id           - Stable unique ID e.g. "ssl-hsts-max-age-too-low"
 * @param {string} params.runner       - Runner name: "ssl" | "dns" | "lighthouse" | "devtools" | "crawler" | "security"
 * @param {string} params.category     - One of CATEGORY values
 * @param {string} params.severity     - One of SEVERITY values
 * @param {string} params.title        - One-line plain English title
 * @param {string} params.detail       - Full explanation: what it means, why it matters
 * @param {string} params.evidence     - Raw data proving the finding
 * @param {string} params.recommendation - Specific, actionable fix instruction
 * @param {string|null} [params.owasp] - OWASP Top 10 ref: "A01"–"A10" or null
 * @param {string|null} [params.wcag]  - WCAG criterion e.g. "1.4.3" or null
 * @returns {Object} Validated finding
 */
export function createFinding({
  id, runner, category, severity, title, detail, evidence, recommendation,
  owasp = null, wcag = null
}) {
  for (const field of REQUIRED_FIELDS) {
    const value = { id, runner, category, severity, title, detail, evidence, recommendation }[field];
    if (!value || typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Finding validation failed: "${field}" is required and must be a non-empty string. id="${id || 'unknown'}"`);
    }
  }

  if (!Object.values(SEVERITY).includes(severity)) {
    throw new Error(`Invalid severity "${severity}" in finding "${id}". Must be: ${Object.values(SEVERITY).join(' | ')}`);
  }

  if (!Object.values(CATEGORY).includes(category)) {
    throw new Error(`Invalid category "${category}" in finding "${id}". Must be: ${Object.values(CATEGORY).join(' | ')}`);
  }

  return {
    id,
    runner,
    category,
    severity,
    title,
    detail,
    evidence,
    recommendation,
    owasp,
    wcag,
    status: STATUS.NEW
  };
}

/**
 * Creates a runner error finding.
 * Used when a runner fails — ensures the orchestrator never crashes.
 *
 * @param {string} runner  - Runner name
 * @param {string} message - Error message
 * @returns {Object} Error finding
 */
export function createErrorFinding(runner, message) {
  return createFinding({
    id:             `${runner}-runner-error`,
    runner,
    category:       CATEGORY.FUNCTIONAL,
    severity:       SEVERITY.INFO,
    title:          `Runner error: ${runner} — ${message}`,
    detail:         `The ${runner} runner encountered an error and could not complete. All other runners are unaffected.`,
    evidence:       message,
    recommendation: 'Check runner configuration and tool availability. Review console output for details.',
    owasp:          null,
    wcag:           null
  });
}

/**
 * Creates the standardised runner result envelope.
 * Every runner returns one of these.
 *
 * @param {string}   runner   - Runner name
 * @param {string}   url      - URL or hostname that was audited
 * @param {Object[]} findings - Array of finding objects from createFinding()
 * @param {Object}  [metrics] - Raw metrics: scores, counts, snapshots
 * @returns {Object} Runner result envelope
 */
export function createRunnerResult(runner, url, findings = [], metrics = {}) {
  return {
    runner,
    url,
    timestamp: new Date().toISOString(),
    status:    'completed',
    findings,
    metrics
  };
}
