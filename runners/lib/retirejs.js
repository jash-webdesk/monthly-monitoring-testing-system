/**
 * Retire.js vulnerable-library scanner — OWASP A03 (Software Supply Chain Failures).
 * Fetches each script actually loaded by a page and matches its content against the
 * Retire.js CVE database, catching known-vulnerable versions of jQuery and similar
 * libraries even when the site owner never updated a version number anywhere visible.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { scanFileContent, replaceVersion } from 'retire';
import { logger } from '../../lib/logger.js';

const REPO_URL = 'https://raw.githubusercontent.com/RetireJS/retire.js/master/repository/jsrepository-v5.json';
const CACHE_DIR = resolve(process.cwd(), '.cache');
const CACHE_PATH = join(CACHE_DIR, 'retire-repository.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — this DB changes rarely; avoid hammering GitHub every run
const FETCH_TIMEOUT_MS = 10_000;
const MAX_SCRIPT_BYTES = 3 * 1024 * 1024; // skip anything absurdly large rather than hang on it

const hasher = { sha1: (data) => createHash('sha1').update(data).digest('hex') };
const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

let cachedRepo = null; // in-process memoization — avoids re-reading the cache file on every pass in the same run

/**
 * Loads the Retire.js vulnerability database, caching it locally for 24h.
 * A GitHub outage or network hiccup must never break the rest of the security audit —
 * falls back to a stale on-disk cache, and returns null (scan is skipped) only if
 * there is truly no usable copy anywhere.
 *
 * @returns {Promise<Object|null>}
 */
export async function loadRetireRepository() {
  if (cachedRepo) return cachedRepo;

  if (existsSync(CACHE_PATH)) {
    try {
      const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        cachedRepo = cached.repo;
        return cachedRepo;
      }
    } catch { /* corrupted cache file — fall through and refetch */ }
  }

  try {
    const text = await fetch(REPO_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
    // The repo JSON ships with a literal "§§version§§" placeholder inside each regex
    // string — replaceVersion() must run on the raw text BEFORE JSON.parse, not after.
    const repo = JSON.parse(replaceVersion(text));
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), repo }), 'utf8');
    cachedRepo = repo;
    return repo;
  } catch (err) {
    logger.warn(`  Retire.js vulnerability database fetch failed: ${err.message}`);
    if (existsSync(CACHE_PATH)) {
      try {
        cachedRepo = JSON.parse(readFileSync(CACHE_PATH, 'utf8')).repo;
        logger.warn('  Falling back to stale cached Retire.js database.');
        return cachedRepo;
      } catch { /* truly unusable — give up below */ }
    }
    logger.warn('  No usable Retire.js database available — vulnerable-library scan skipped this run.');
    return null;
  }
}

/**
 * Scans a list of script URLs against the Retire.js database.
 * Returns one entry per vulnerable component detected. Individual script fetch/scan
 * failures are skipped silently — one broken CDN link must not abort the whole scan.
 *
 * @param {string[]} scriptUrls
 * @returns {Promise<{url: string, component: string, version: string, severity: string, vulnerabilities: Object[]}[]>}
 */
export async function scanScriptsForVulnerabilities(scriptUrls) {
  const repo = await loadRetireRepository();
  if (!repo) return [];

  const findings = [];

  for (const url of [...new Set(scriptUrls)]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      const contentLength = res.headers.get('content-length');
      if (contentLength && Number(contentLength) > MAX_SCRIPT_BYTES) continue;

      const content = await res.text();
      if (content.length > MAX_SCRIPT_BYTES) continue;

      const results = scanFileContent(content, repo, hasher);
      for (const result of results) {
        if (!result.vulnerabilities || result.vulnerabilities.length === 0) continue;
        const worst = result.vulnerabilities.reduce((a, b) =>
          (SEVERITY_RANK[b.severity] ?? 0) > (SEVERITY_RANK[a.severity] ?? 0) ? b : a
        );
        if ((SEVERITY_RANK[worst.severity] ?? 0) === 0) continue; // 'none' severity — not worth flagging
        findings.push({ url, component: result.component, version: result.version, severity: worst.severity, vulnerabilities: result.vulnerabilities });
      }
    } catch {
      // Individual script fetch/scan failure — skip, don't fail the whole pass.
    }
  }
  return findings;
}
