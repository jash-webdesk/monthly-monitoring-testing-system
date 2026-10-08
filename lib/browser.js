import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { playwrightProxy } from './net.js';

/**
 * The single place that launches Chromium for every runner and report generator, so that
 * environment differences (root user, proxy, alternative browser binary) are handled once.
 *
 * Environment knobs (all optional):
 *   CHROMIUM_EXECUTABLE_PATH     use this browser binary instead of Playwright's own download
 *   BROWSER_IGNORE_CERT_ERRORS=1 add --ignore-certificate-errors (only if a TLS-inspecting proxy's CA is not trusted)
 * A binary path written by scripts/ensure-browser.js to .cache/browser/executable-path.txt is also honoured.
 */

const PATH_FILE = '.cache/browser/executable-path.txt';

/** @returns {string|null} explicit browser executable, if one was configured or installed by ensure-browser. */
export function browserExecutable() {
  if (process.env.CHROMIUM_EXECUTABLE_PATH) return process.env.CHROMIUM_EXECUTABLE_PATH;
  try {
    if (existsSync(PATH_FILE)) {
      const p = readFileSync(PATH_FILE, 'utf8').trim();
      if (p && existsSync(p)) return p;
    }
  } catch { /* fall through to Playwright's default */ }
  return null;
}

/**
 * Chrome/Chromium binary for tools that find the browser themselves (the Lighthouse CLI fallback).
 * Preference: configured executable, then Playwright's installed Chromium, else null (let the tool search).
 * @returns {string|null}
 */
export function chromeForTools() {
  const exe = browserExecutable();
  if (exe) return exe;
  try {
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch { return null; }
}

/**
 * Drop-in replacement for chromium.launch().
 * @param {import('playwright').LaunchOptions} [options]
 */
export async function launchChromium(options = {}) {
  const exe = browserExecutable();
  const proxy = options.proxy ?? playwrightProxy();
  const args = new Set([...(options.args ?? []), '--no-sandbox', '--disable-dev-shm-usage']);
  if (process.env.BROWSER_IGNORE_CERT_ERRORS === '1') args.add('--ignore-certificate-errors');
  return chromium.launch({
    headless: true,
    ...options,
    args: [...args],
    ...(exe ? { executablePath: exe } : {}),
    ...(proxy ? { proxy } : {})
  });
}
