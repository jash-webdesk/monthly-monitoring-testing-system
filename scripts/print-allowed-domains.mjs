#!/usr/bin/env node
/** Prints the domains a Custom network allowlist in the Claude Code cloud environment must include. */
import { loadProjects } from '../lib/config.js';

const set = new Set([
  // services used by the engine
  'www.googleapis.com', 'pagespeedonline.googleapis.com', 'api.uptimerobot.com', 'cloudflare-dns.com', 'dns.google',
  // npm and browser downloads for the setup script
  'registry.npmjs.org', 'cdn.playwright.dev', 'playwright.azureedge.net', 'playwright.download.prss.microsoft.com', 'github.com', 'objects.githubusercontent.com'
]);
for (const p of loadProjects()) {
  for (const d of p.domains ?? []) set.add(d);
  for (const s of p.sites ?? []) { set.add(s.hostname); for (const u of Object.values(s.pages ?? {})) try { set.add(new URL(u).hostname); } catch { /* ignore */ } }
  if (p.id === 'genpet') set.add('app.genpet.org');
}
console.log([...set].sort().join('\n'));
