/**
 * OWASP Top 10:2025 Mapping
 *
 * Maps check_id values to OWASP Top 10:2025 category codes and reference URLs.
 *
 * IMPORTANT: These are 2025 edition codes. Do NOT mix with 2021 codes.
 * Key shifts from 2021 -> 2025:
 *   - Cryptographic Failures:    A02 (2021) -> A04 (2025)
 *   - Security Misconfiguration: A05 (2021) -> A02 (2025)
 *   - Vulnerable Components:     A06 (2021) -> A03 (2025) [renamed: Supply Chain Failures]
 *   - SSRF:                      A10 (2021) -> removed; replaced by Mishandling of Exceptional Conditions
 *
 * Reference: https://owasp.org/Top10/2025/
 */

export const OWASP_VERSION = '2025';

/**
 * Full OWASP Top 10:2025 category definitions with reference URLs.
 */
export const OWASP_CATEGORIES = {
  A01: {
    name: 'Broken Access Control',
    url:  'https://owasp.org/Top10/2025/A01_2025-Broken_Access_Control/',
  },
  A02: {
    name: 'Security Misconfiguration',
    url:  'https://owasp.org/Top10/2025/A02_2025-Security_Misconfiguration/',
  },
  A03: {
    name: 'Software Supply Chain Failures',
    url:  'https://owasp.org/Top10/2025/A03_2025-Software_Supply_Chain_Failures/',
  },
  A04: {
    name: 'Cryptographic Failures',
    url:  'https://owasp.org/Top10/2025/A04_2025-Cryptographic_Failures/',
  },
  A05: {
    name: 'Injection',
    url:  'https://owasp.org/Top10/2025/A05_2025-Injection/',
  },
  A06: {
    name: 'Insecure Design',
    url:  'https://owasp.org/Top10/2025/A06_2025-Insecure_Design/',
  },
  A07: {
    name: 'Authentication Failures',
    url:  'https://owasp.org/Top10/2025/A07_2025-Authentication_Failures/',
  },
  A08: {
    name: 'Software or Data Integrity Failures',
    url:  'https://owasp.org/Top10/2025/A08_2025-Software_or_Data_Integrity_Failures/',
  },
  A09: {
    name: 'Security Logging and Alerting Failures',
    url:  'https://owasp.org/Top10/2025/A09_2025-Security_Logging_and_Alerting_Failures/',
  },
  A10: {
    name: 'Mishandling of Exceptional Conditions',
    url:  'https://owasp.org/Top10/2025/A10_2025-Mishandling_of_Exceptional_Conditions/',
  },
};

/**
 * Maps check_id -> OWASP 2025 category code.
 *
 * Separation note (A03 vs A08):
 *   - A03 (Supply Chain): Untrusted dependency *entering* the codebase (Retire.js CVEs)
 *   - A08 (Data Integrity): Runtime tampering of a *delivered* asset (SRI failures)
 */
const OWASP_MAP = {
  // A01: Broken Access Control
  'security.cookie-samesite-missing':              'A01',
  'security.api-unauthenticated-pii':              'A01',
  'security.directory-listing-enabled':            'A01',

  // A02: Security Misconfiguration
  'security.csp-missing':                          'A02',
  'security.x-frame-options-missing':              'A02',
  'security.x-content-type-options-missing':       'A02',
  'security.coop-missing':                         'A02',
  'security.referrer-policy-missing':              'A02',
  'security.permissions-policy-missing':           'A02',
  'security.server-header-verbose':                'A02',
  'security.sensitive-path-exposed':               'A02',

  // A03: Software Supply Chain Failures
  'security.retire-js-cve':                        'A03',
  'security.unverified-cdn-source':                'A03',

  // A04: Cryptographic Failures
  'ssl.hsts-missing':                              'A04',
  'ssl.hsts-max-age-too-low':                      'A04',
  'ssl.hsts-no-includesubdomains':                 'A04',
  'security.cookie-secure-missing':                'A04',
  'security.jwt-alg-none':                         'A04',
  'security.jwt-weak-algorithm':                   'A04',
  'ssl.certificate-expired':                       'A04',
  'ssl.certificate-expiring-soon':                 'A04',
  'ssl.tls-version-outdated':                      'A04',

  // A07: Authentication Failures
  'security.cookie-httponly-missing':              'A07',
  'security.session-fixation-risk':                'A07',

  // A08: Software or Data Integrity Failures
  'security.sri-missing':                          'A08',

  // A09: Security Logging and Alerting Failures
  'security.no-csp-reporting-endpoint':            'A09',
};

/**
 * Returns the OWASP 2025 category code, name, version, and reference URL
 * for a given check_id. Returns nulls for checks with no OWASP mapping.
 *
 * @param {string} checkId - The check_id of the finding (e.g. 'ssl.hsts-missing')
 * @returns {{ owasp: string|null, owasp_version: string|null, owasp_name: string|null, owasp_url: string|null }}
 */
export function getOwaspMapping(checkId) {
  const code = OWASP_MAP[checkId] ?? null;
  if (!code) {
    return { owasp: null, owasp_version: null, owasp_name: null, owasp_url: null };
  }
  const category = OWASP_CATEGORIES[code];
  return {
    owasp:         code,
    owasp_version: OWASP_VERSION,
    owasp_name:    category.name,
    owasp_url:     category.url,
  };
}

/**
 * Returns the full OWASP category object for a given code.
 * Useful for report generation when you already have the code.
 *
 * @param {string} code - e.g. 'A04'
 * @returns {{ name: string, url: string } | null}
 */
export function getOwaspCategory(code) {
  return OWASP_CATEGORIES[code] ?? null;
}
