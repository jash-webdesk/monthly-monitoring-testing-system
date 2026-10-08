import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file (not the working directory) so the engine works from any cwd.
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONFIG_DIR = resolve(ROOT, 'config');
const PROJECTS_DIR = resolve(ROOT, 'projects');

/** Per-process overrides applied on top of the project files (e.g. the Before/After scores from a prompt). */
const runtimeOverrides = new Map();

/** @returns {string} absolute path of the repository root */
export function repoRoot() { return ROOT; }

function loadJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }
}

/**
 * Loads every projects/*.json. Files starting with "_" are ignored (templates).
 * @returns {Object[]} project configs, sorted by id
 */
export function loadProjects() {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => loadJsonFile(resolve(PROJECTS_DIR, f)))
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** @returns {Object|null} one project by id */
export function getProject(id) {
  return loadProjects().find((p) => p.id === id) ?? null;
}

/**
 * Flat list of all monitored sites across projects, in the shape the runners and report
 * generators have always consumed ({ sites: [{ hostname, name, platform, pages, ... }] }).
 * Each site additionally carries `project` and `archiveKey`.
 * @returns {{ sites: Object[] }}
 */
export function loadSitesConfig() {
  const sites = loadProjects().flatMap((p) => (p.sites ?? []).map((s) => ({ ...s, project: p.id, projectName: p.name, archiveKey: s.archiveKey ?? s.hostname })));
  return { sites };
}

/**
 * Loads known issues for a specific hostname from config/known-issues.json.
 * @param {string} hostname - e.g. "partsconnexion.com"
 * @returns {Object[]} Known issue entries for this hostname
 */
export function loadKnownIssues(hostname) {
  const data = loadJsonFile(resolve(CONFIG_DIR, 'known-issues.json'));
  if (!data) return [];
  return data[hostname] ?? [];
}

/**
 * Registers per-run overrides for a hostname. Currently: { scores } in the legacy shape the report
 * generators read (see engine/scores.js toLegacyScores). Lasts for the life of the process only.
 * @param {string} hostname
 * @param {Object} overrides
 */
export function setRuntimeOverrides(hostname, overrides) {
  runtimeOverrides.set(hostname, { ...(runtimeOverrides.get(hostname) ?? {}), ...overrides });
}

/**
 * Returns the merged site config for a hostname (project file + runtime overrides).
 * Falls back to sensible defaults if the hostname is not in any project.
 * @param {string} hostname
 * @returns {Object} Site config
 */
export function getSiteConfig(hostname) {
  const { sites } = loadSitesConfig();
  const site = sites.find((s) => s.hostname === hostname || s.archiveKey === hostname);
  return {
    hostname,
    timeout: 30000,
    retries: 2,
    ...site,
    ...(runtimeOverrides.get(hostname) ?? runtimeOverrides.get(site?.hostname) ?? {})
  };
}
