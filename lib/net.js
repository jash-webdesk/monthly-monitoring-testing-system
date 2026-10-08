import https from 'node:https';
import { logger } from './logger.js';

/**
 * Network adapter for sandboxed / proxied environments (e.g. Claude Code cloud sessions, where
 * all outbound traffic goes through an HTTP/HTTPS proxy). Node's built-in fetch, https.get and
 * Chromium do NOT read HTTPS_PROXY by themselves, so every runner would fail there even though
 * the destination is allowed. Call installNetwork() once at process start; it is a no-op when no
 * proxy is configured (normal local runs).
 */

let installed = false;

/** @returns {string|null} the proxy URL from the standard environment variables, if any. */
export function proxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
}

/**
 * Makes fetch() and https.get()/request() proxy-aware. Safe to call repeatedly.
 * @returns {Promise<{ proxy: string|null }>}
 */
export async function installNetwork() {
  const proxy = proxyUrl();
  if (installed || !proxy) { installed = true; return { proxy: installed ? proxy : null }; }
  installed = true;
  try {
    const { setGlobalDispatcher, ProxyAgent } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
  } catch (err) {
    logger.warn(`[net] could not enable proxy for fetch(): ${err.message}`);
  }
  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    https.globalAgent = new HttpsProxyAgent(proxy);
  } catch (err) {
    logger.warn(`[net] could not enable proxy for https requests: ${err.message}`);
  }
  logger.info(`[net] outbound traffic routed through proxy ${new URL(proxy).host}`);
  return { proxy };
}

/**
 * Proxy settings in Playwright's launch format, or undefined when no proxy is configured.
 * @returns {{ server: string, username?: string, password?: string, bypass?: string }|undefined}
 */
export function playwrightProxy() {
  const p = proxyUrl();
  if (!p) return undefined;
  const u = new URL(p);
  return {
    server: `${u.protocol}//${u.host}`,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    bypass: process.env.NO_PROXY || process.env.no_proxy || 'localhost,127.0.0.1'
  };
}

/** Restores direct (non-proxied) networking. Mainly for tests. */
export async function resetNetwork() {
  installed = false;
  try { const { setGlobalDispatcher, Agent } = await import('undici'); setGlobalDispatcher(new Agent()); } catch { /* undici not installed */ }
  https.globalAgent = new https.Agent();
}
