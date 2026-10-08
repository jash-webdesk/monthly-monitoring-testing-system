#!/usr/bin/env node
/**
 * Pre-flight check for a cloud (or any sandboxed) session. Prints PASS / WARN / FAIL per check and never prints secret values.
 *   node scripts/cloud-preflight.mjs [--project <id>]
 */
import { readFileSync, existsSync } from 'node:fs';
import { installNetwork, proxyUrl } from '../lib/net.js';
import { launchChromium } from '../lib/browser.js';
import resolver, { resolverMode } from '../lib/resolver.js';
import { loadProjects } from '../lib/config.js';

if (existsSync('.env')) for (const l of readFileSync('.env', 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0 && !l.trim().startsWith('#')) { const k = l.slice(0, i).trim(); if (!(k in process.env)) process.env[k] = l.slice(i + 1).trim().replace(/^['"]|['"]$/g, ''); } }

const args = process.argv.slice(2);
const only = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;
const rows = [];
const add = (level, name, detail = '') => { rows.push({ level, name, detail }); console.log(`${level.padEnd(5)} ${name}${detail ? ' - ' + detail : ''}`); };

const major = Number(process.versions.node.split('.')[0]);
add(major >= 22 ? 'PASS' : 'WARN', 'node version', process.versions.node + (major >= 22 ? '' : ' (project targets 22+)'));

const net = await installNetwork();
add('PASS', 'proxy', net.proxy ? `routed through ${new URL(net.proxy).host}` : 'none configured (direct network)');

for (const [label, url] of [['public internet', 'https://example.com/'], ['PageSpeed API host', 'https://www.googleapis.com/'], ['DNS-over-HTTPS host', 'https://cloudflare-dns.com/dns-query?name=example.com&type=A']]) {
  try { const r = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(15000) }); add('PASS', label, `HTTP ${r.status}`); }
  catch (e) { add('FAIL', label, `${e.cause?.code ?? e.message} - check the environment network access level (needs Full, or a custom allowlist)`); }
}

try { const ns = await resolver.resolveNs('example.com'); add('PASS', 'dns', `${await resolverMode()} mode, ${ns.length} NS records`); }
catch (e) { add('FAIL', 'dns', e.message); }

let browser;
try {
  browser = await launchChromium();
  const page = await browser.newPage();
  const resp = await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  add('PASS', 'browser', `Chromium ${browser.version()} loaded example.com (${resp.status()})`);
  const issuer = (await resp.securityDetails())?.issuer ?? '';
  if (issuer && !/digicert|let'?s encrypt|google trust|cloudflare|sectigo|amazon|globalsign|microsoft|comodo|ssl corporation|isrg/i.test(issuer)) {
    add('WARN', 'tls inspection', `certificate issuer "${issuer}" is not a well-known public CA; the egress proxy may be inspecting TLS. SSL audit results could be unreliable.`);
  } else add('PASS', 'tls inspection', issuer ? `issuer ${issuer}` : 'no certificate details');
} catch (e) {
  add('FAIL', 'browser', `${e.message.split('\n')[0]} - run: node scripts/ensure-browser.mjs`);
} finally { await browser?.close().catch(() => {}); }

const projects = loadProjects().filter((p) => !only || p.id === only);
for (const p of projects) {
  for (const s of p.secrets ?? []) {
    const present = Boolean(process.env[s.env]);
    add(present ? 'PASS' : s.required ? 'FAIL' : 'WARN', `env ${s.env}`, `${p.id}: ${present ? 'set' : s.required ? 'MISSING (required)' : 'not set (optional)'}`);
  }
}

const fails = rows.filter((r) => r.level === 'FAIL').length;
console.log(`\n${fails ? 'Preflight found ' + fails + ' blocking problem(s).' : 'Preflight passed.'}`);
process.exit(fails ? 1 : 0);
