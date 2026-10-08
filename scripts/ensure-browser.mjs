#!/usr/bin/env node
/**
 * Makes sure a Chromium that Playwright can launch is available. Safe to run repeatedly.
 *   1. try the Playwright browser already installed
 *   2. otherwise download it with `npx playwright install chromium` (adds --with-deps when running as root)
 *   3. otherwise fall back to the @sparticuz/chromium npm package and record its path in .cache/browser/executable-path.txt
 * Exit code 0 when a browser launches, 1 otherwise.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

async function canLaunch() {
  try {
    const { launchChromium } = await import('../lib/browser.js');
    const b = await launchChromium();
    const v = b.version();
    await b.close();
    return v;
  } catch (err) {
    return { error: err.message.split('\n')[0] };
  }
}

const run = (cmd) => { console.log(`> ${cmd}`); execSync(cmd, { stdio: 'inherit' }); };

let r = await canLaunch();
if (typeof r === 'string') { console.log(`Browser OK (Chromium ${r}).`); process.exit(0); }
console.log(`No usable browser yet: ${r.error}`);

try {
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  run(`npx playwright install ${root ? '--with-deps ' : ''}chromium`);
} catch (err) { console.log(`Playwright browser download failed: ${err.message.split('\n')[0]}`); }

r = await canLaunch();
if (typeof r === 'string') { console.log(`Browser OK (Chromium ${r}).`); process.exit(0); }

console.log('Falling back to @sparticuz/chromium ...');
try {
  run('npm install --no-save @sparticuz/chromium');
  const { default: sparticuz } = await import('@sparticuz/chromium');
  const exe = await sparticuz.executablePath();
  mkdirSync('.cache/browser', { recursive: true });
  writeFileSync('.cache/browser/executable-path.txt', exe);
  r = await canLaunch();
  if (typeof r === 'string') { console.log(`Browser OK via @sparticuz/chromium (Chromium ${r}).`); process.exit(0); }
} catch (err) { console.log(`Fallback failed: ${err.message.split('\n')[0]}`); }

console.error('No browser could be launched. Browser-based audits (performance via PageSpeed still works) will fail. See docs/LIMITATIONS.md.');
process.exit(1);
