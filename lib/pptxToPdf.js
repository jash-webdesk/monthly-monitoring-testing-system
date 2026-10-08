import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from './logger.js';

/**
 * Converts a .pptx to .pdf so a client deck can be delivered in both formats.
 *   1. LibreOffice (soffice) when installed - the path used in the cloud (apt install libreoffice-impress)
 *   2. Microsoft PowerPoint through COM on Windows - used on a local machine
 * Returns the PDF path, or null when no converter is available (the caller reports that honestly).
 */

function findSoffice() {
  for (const cmd of ['soffice', 'libreoffice']) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.split(/\r?\n/)[0].trim();
  }
  for (const p of ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', '/usr/bin/soffice', '/opt/libreoffice/program/soffice']) if (existsSync(p)) return p;
  return null;
}

function viaSoffice(soffice, pptx, pdf) {
  // Own profile dir and temp copy: avoids lock clashes with a running office instance and odd characters in paths.
  const work = mkdtempSync(join(tmpdir(), 'pptx2pdf-'));
  try {
    const src = join(work, 'deck.pptx');
    copyFileSync(pptx, src);
    execFileSync(soffice, ['--headless', `-env:UserInstallation=file:///${join(work, 'profile').replace(/\\/g, '/')}`, '--convert-to', 'pdf', '--outdir', work, src], { stdio: 'pipe', timeout: 180000 });
    const out = join(work, 'deck.pdf');
    if (!existsSync(out)) return false;
    mkdirSync(dirname(pdf), { recursive: true });
    copyFileSync(out, pdf);
    return true;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

function viaPowerPoint(pptx, pdf) {
  const ps = `
$ErrorActionPreference = 'Stop'
$wasRunning = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
$app = New-Object -ComObject PowerPoint.Application
try {
  $pres = $app.Presentations.Open('${pptx.replace(/'/g, "''")}', $true, $false, $false)
  try { $pres.SaveAs('${pdf.replace(/'/g, "''")}', 32) } finally { $pres.Close() }
} finally { if (-not $wasRunning) { $app.Quit() } }
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 180000 });
  return r.status === 0 && existsSync(pdf);
}

/** @returns {string|null} pdf path or null */
export function convertPptxToPdf(pptxPath, pdfPath = pptxPath.replace(/\.pptx$/i, '.pdf')) {
  try {
    const soffice = findSoffice();
    if (soffice && viaSoffice(soffice, pptxPath, pdfPath)) return pdfPath;
    if (process.platform === 'win32' && viaPowerPoint(pptxPath, pdfPath)) return pdfPath;
  } catch (err) {
    logger.warn(`PPTX to PDF conversion failed for ${basename(pptxPath)}: ${err.message.split('\n')[0]}`);
  }
  return null;
}
