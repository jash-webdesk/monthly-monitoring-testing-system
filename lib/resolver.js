import nativeDns from 'node:dns/promises';
import { logger } from './logger.js';

/**
 * DNS resolver with the same method names the DNS runner already uses (a subset of node:dns/promises).
 *
 * Why: sandboxed environments (e.g. Claude Code cloud sessions) only document HTTP/HTTPS egress, so
 * raw UDP/53 lookups can fail even when the domain is perfectly healthy. In 'auto' mode we probe the
 * native resolver once and, if it cannot work, switch to DNS-over-HTTPS (Cloudflare, then Google).
 *
 * DNS_MODE = auto (default) | native | doh
 */

const TYPES = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
const NATIVE_BROKEN = new Set(['ECONNREFUSED', 'ETIMEOUT', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EPERM']);

let mode = null; // resolved lazily: 'native' | 'doh'

async function chooseMode() {
  if (mode) return mode;
  const forced = (process.env.DNS_MODE ?? 'auto').toLowerCase();
  if (forced === 'native' || forced === 'doh') { mode = forced; return mode; }
  try {
    await Promise.race([
      nativeDns.resolveNs('example.com'),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('probe timeout'), { code: 'ETIMEOUT' })), 4000))
    ]);
    mode = 'native';
  } catch (err) {
    mode = NATIVE_BROKEN.has(err.code) ? 'doh' : 'native';
    if (mode === 'doh') logger.warn(`[dns] native resolver unavailable (${err.code ?? err.message}); using DNS-over-HTTPS`);
  }
  return mode;
}

/** @returns {Promise<'native'|'doh'>} the resolver actually in use (for reports/diagnostics) */
export async function resolverMode() { return chooseMode(); }

async function dohQuery(name, type) {
  const endpoints = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`
  ];
  let lastErr;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.Status === 3) throw Object.assign(new Error(`NXDOMAIN ${name}`), { code: 'ENOTFOUND' });
      const want = TYPES[type];
      const answers = (body.Answer ?? []).filter((a) => a.type === want);
      if (!answers.length) throw Object.assign(new Error(`No ${type} data for ${name}`), { code: 'ENODATA' });
      return answers;
    } catch (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') throw err;
      lastErr = err;
    }
  }
  throw Object.assign(new Error(`DNS-over-HTTPS failed for ${name}: ${lastErr?.message}`), { code: 'EAI_AGAIN' });
}

/** TXT answers arrive as one string of quoted chunks ("a" "b"); node returns string[][]. */
function txtChunks(data) {
  const chunks = [...String(data).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  return chunks.length ? chunks : [String(data)];
}
const stripDot = (s) => String(s).replace(/\.$/, '');

export default {
  async resolve4(h) { return (await chooseMode()) === 'native' ? nativeDns.resolve4(h) : (await dohQuery(h, 'A')).map((a) => a.data); },
  async resolve6(h) { return (await chooseMode()) === 'native' ? nativeDns.resolve6(h) : (await dohQuery(h, 'AAAA')).map((a) => a.data); },
  async resolveCname(h) { return (await chooseMode()) === 'native' ? nativeDns.resolveCname(h) : (await dohQuery(h, 'CNAME')).map((a) => stripDot(a.data)); },
  async resolveNs(h) { return (await chooseMode()) === 'native' ? nativeDns.resolveNs(h) : (await dohQuery(h, 'NS')).map((a) => stripDot(a.data)); },
  async resolveMx(h) {
    if ((await chooseMode()) === 'native') return nativeDns.resolveMx(h);
    return (await dohQuery(h, 'MX')).map((a) => { const [p, ex] = String(a.data).split(/\s+/); return { priority: Number(p), exchange: stripDot(ex) }; });
  },
  async resolveTxt(h) { return (await chooseMode()) === 'native' ? nativeDns.resolveTxt(h) : (await dohQuery(h, 'TXT')).map((a) => txtChunks(a.data)); }
};
