import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFinding, createErrorFinding, createRunnerResult, SEVERITY, CATEGORY } from '../lib/result.js';
import { logger } from '../lib/logger.js';
import { chromeForTools } from '../lib/browser.js';

// Load .env file manually if it exists
const envPath = resolve(process.cwd(), '.env');
const skipDotenv = process.env.MM_NO_DOTENV === '1' || process.argv.includes('--no-env');
if (!skipDotenv && existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const firstEq = trimmed.indexOf('=');
    if (firstEq === -1) continue;
    const key = trimmed.slice(0, firstEq).trim().replace(/^['"]|['"]$/g, '');
    const value = trimmed.slice(firstEq + 1).trim().replace(/^['"]|['"]$/g, '');
    process.env[key] = value;
  }
}

const execAsync  = promisify(exec);
const RUNNER_NAME = 'lighthouse';
const EXEC_TIMEOUT_MS = 120_000; // 2 minutes per preset — Lighthouse can be slow on cold start

// Blueprint Section 9: "To reduce single-run variance, Lighthouse audits are run three
// times and the median result is used for reporting." Mobile lab scores in particular
// have high run-to-run variance (CPU/network throttling on a shared testing backend) —
// a single sample can look like a false regression or a false improvement.
const RUNS_PER_PRESET = 3;

/**
 * Core Web Vitals thresholds.
 * Source: https://web.dev/vitals/
 * CLS is unitless; all others are milliseconds.
 */
const THRESHOLDS = {
  fcp: { good: 1800, poor: 3000 },
  si:  { good: 3400, poor: 5800 },
  lcp: { good: 2500, poor: 4000 },
  tbt: { good: 200,  poor: 600  },
  tti: { good: 3800, poor: 7300 },
  cls: { good: 0.1,  poor: 0.25 }
};

/**
 * Runs Lighthouse for a URL — desktop preset then mobile preset, sequentially.
 * Running them in parallel would cause browser conflicts.
 *
 * @param {string} url - Full URL e.g. "https://partsconnexion.com/"
 * @returns {Promise<Object>} Runner result envelope
 */
export async function runLighthouse(url) {
  logger.runnerStart(RUNNER_NAME);

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (err) {
    const result = createRunnerResult(RUNNER_NAME, url, [
      createErrorFinding(RUNNER_NAME, `Invalid URL: ${err.message}`)
    ]);
    logger.runnerDone(RUNNER_NAME, 1);
    return result;
  }

  const findings = [];
  const metrics  = { hostname, url, desktop: null, mobile: null };
  const ts       = Date.now();
  const tmp      = tmpdir();

  // ── Desktop ─────────────────────────────────────────────────────
  const desktopResult = await runPresetMedian(url, 'desktop', hostname, tmp, ts);

  if (desktopResult.error) {
    findings.push(createErrorFinding(RUNNER_NAME, `Desktop preset: ${desktopResult.error}`));
    logger.runnerError(RUNNER_NAME, `Desktop: ${desktopResult.error}`);
  } else {
    metrics.desktop = desktopResult.data;
    generateFindings(findings, desktopResult.data, 'desktop');
  }

  // ── Mobile ──────────────────────────────────────────────────────
  const mobileResult = await runPresetMedian(url, 'mobile', hostname, tmp, ts);

  if (mobileResult.error) {
    findings.push(createErrorFinding(RUNNER_NAME, `Mobile preset: ${mobileResult.error}`));
    logger.runnerError(RUNNER_NAME, `Mobile: ${mobileResult.error}`);
  } else {
    metrics.mobile = mobileResult.data;
    generateFindings(findings, mobileResult.data, 'mobile');
  }

  const result = createRunnerResult(RUNNER_NAME, url, findings, metrics);
  logger.runnerDone(RUNNER_NAME, findings.length);
  return result;
}

// ── Private: run one Lighthouse preset multiple times, use the median ──

/**
 * Runs a preset RUNS_PER_PRESET times and returns the run whose overall performance
 * score is the median — not an average of independently-averaged metrics, which would
 * Frankenstein together LCP from one run with TBT from another. Picking the median *run*
 * keeps every metric internally consistent with the run that produced it.
 *
 * @param {string} url
 * @param {'desktop'|'mobile'} preset
 * @param {string} hostname
 * @param {string} tmp - temp directory for the CLI-fallback output file
 * @param {number} ts  - timestamp used to namespace temp files for this audit
 * @returns {Promise<{data: Object|null, error: string|null}>}
 */
async function runPresetMedian(url, preset, hostname, tmp, ts) {
  const attempts = [];
  for (let i = 0; i < RUNS_PER_PRESET; i++) {
    const outputFile = join(tmp, `lh_${hostname}_${preset}_${ts}_${i}.json`);
    attempts.push(await runPreset(url, preset, outputFile));
  }

  const successful = attempts.filter(r => !r.error && r.data && r.data.score !== null);

  if (successful.length === 0) {
    // Every attempt failed — surface the first error rather than inventing a score.
    return attempts[0];
  }

  successful.sort((a, b) => a.data.score - b.data.score);
  const medianIndex  = Math.floor((successful.length - 1) / 2);
  const medianResult = successful[medianIndex];
  const allScores    = successful.map(r => r.data.score);

  logger.info(`  ${preset} performance scores across ${successful.length}/${RUNS_PER_PRESET} successful run(s): [${allScores.join(', ')}] — using median run (${medianResult.data.score}/100)`);

  // Record the sampled scores alongside the chosen run's metrics for auditability —
  // does not change the shape consumers already read (.score, .lcp, etc).
  medianResult.data.sampledScores = allScores;

  return medianResult;
}

// ── Private: run one Lighthouse preset ────────────────────────────

/**
 * Runs a single Lighthouse preset, writes JSON to a temp file, parses it, and cleans up.
 *
 * @param {string}           url        - Target URL
 * @param {'desktop'|'mobile'} preset
 * @param {string}           outputFile - Absolute path for temp JSON output
 * @returns {Promise<{data: Object|null, error: string|null}>}
 */
async function runPreset(url, preset, outputFile) {
  const apiKey = process.env.PAGESPEED_API_KEY;

  if (apiKey) {
    logger.info(`  Querying Google PageSpeed Insights API for ${preset}...`);
    const strategy = preset === 'desktop' ? 'desktop' : 'mobile';
    const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&key=${apiKey}&category=performance&category=accessibility&category=best_practices&category=seo`;
    try {
      const res = await fetch(psiUrl);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const msg = errorData?.error?.message || `HTTP ${res.status}`;
        throw new Error(`Google API returned error: ${msg}`);
      }
      const data = await res.json();
      const lh = data.lighthouseResult;
      if (!lh || !lh.categories) {
        throw new Error('Invalid response structure from Google API');
      }
      return { data: parseLighthouseJson(lh), error: null };
    } catch (err) {
      return { data: null, error: `PageSpeed Insights API failed: ${err.message}` };
    }
  }

  logger.info(`  Lighthouse ${preset} audit starting (up to 60s)...`);

  const presetFlag   = preset === 'desktop' ? '--preset=desktop' : '';
  const chromeFlags  = '"--headless=new --no-sandbox --disable-gpu"';
  const cmd = [
    'npx lighthouse',
    `"${url}"`,
    '--only-categories=performance',
    '--output=json',
    `--output-path="${outputFile}"`,
    `--chrome-flags=${chromeFlags}`,
    presetFlag,
    '--throttling-method=provided',
    '--quiet'
  ].filter(Boolean).join(' ');

  logger.debug(`CMD: ${cmd}`);

  try {
    // Point the Lighthouse CLI at the engine's browser: a cloud VM has no system Chrome for it to find.
    const chrome = process.env.CHROME_PATH || chromeForTools();
    await execAsync(cmd, { timeout: EXEC_TIMEOUT_MS, env: { ...process.env, ...(chrome ? { CHROME_PATH: chrome } : {}) } });
  } catch (err) {
    // Lighthouse exits non-zero for some audit warnings — still check for output
    if (!existsSync(outputFile)) {
      const msg = err.message?.includes('not found') || err.code === 'ENOENT'
        ? 'Lighthouse CLI not found — ensure npx is available in PATH'
        : err.message ?? 'Unknown execution error';
      return { data: null, error: msg };
    }
    // Output exists despite non-zero exit — treat as soft failure, still parse
    logger.warn(`  Lighthouse ${preset} exited with non-zero code but output exists — parsing anyway`);
  }

  try {
    if (!existsSync(outputFile)) {
      return { data: null, error: `Lighthouse completed but output file was not written` };
    }
    const raw  = readFileSync(outputFile, 'utf8');
    const json = JSON.parse(raw);
    return { data: parseLighthouseJson(json), error: null };
  } catch (parseErr) {
    return { data: null, error: `Failed to parse Lighthouse output: ${parseErr.message}` };
  } finally {
    try { if (existsSync(outputFile)) unlinkSync(outputFile); } catch { /* ignore cleanup error */ }
  }
}

/**
 * Parses raw Lighthouse JSON into a normalised metrics object.
 * Scores are normalised from 0–1 floats to 0–100 integers.
 * Null score (audit not run) is preserved as null — not converted to 0.
 *
 * @param {Object} json - Raw Lighthouse output
 * @returns {Object} Normalised metrics
 */
function parseLighthouseJson(json) {
  const audits = json.audits ?? {};

  // Normalise score: null → null, 0.0 → 0, 1.0 → 100
  const rawScore = json.categories?.performance?.score;
  const score    = (rawScore !== null && rawScore !== undefined)
    ? Math.round(rawScore * 100)
    : null;

  const accessibility = json.categories?.accessibility?.score != null
    ? Math.round(json.categories.accessibility.score * 100)
    : null;

  const bestPractices = json.categories?.['best-practices']?.score != null
    ? Math.round(json.categories['best-practices'].score * 100)
    : null;

  const seo = json.categories?.seo?.score != null
    ? Math.round(json.categories.seo.score * 100)
    : null;

  /**
   * Extracts a single audit metric.
   * @param {string} key - Lighthouse audit key
   */
  const metric = (key) => {
    const audit = audits[key];
    if (!audit) return { value: null, displayValue: 'N/A', score: null };
    const raw = audit.score;
    return {
      value:        audit.numericValue != null ? Math.round(audit.numericValue * 100) / 100 : null,
      displayValue: audit.displayValue ?? 'N/A',
      score:        (raw !== null && raw !== undefined) ? Math.round(raw * 100) : null
    };
  };

  // Extract opportunities — items with potential ms or byte savings
  const opportunities = [];
  for (const [id, audit] of Object.entries(audits)) {
    if (audit.details?.type === 'opportunity') {
      const savingsMs    = audit.numericValue ?? 0;
      const savingsBytes = audit.details.overallSavingsBytes ?? 0;
      if (savingsMs > 0 || savingsBytes > 0) {
        opportunities.push({
          id,
          title:        audit.title,
          savingsMs:    Math.round(savingsMs),
          savingsBytes: Math.round(savingsBytes),
          displayValue: audit.displayValue ?? ''
        });
      }
    }
  }
  // Largest savings first
  opportunities.sort((a, b) => b.savingsMs - a.savingsMs);

  // Failed diagnostics (score < 90, table type)
  const diagnostics = [];
  for (const [id, audit] of Object.entries(audits)) {
    if (audit.score !== null && audit.score < 0.9 && audit.details?.type === 'table') {
      diagnostics.push({
        id,
        title: audit.title,
        score: audit.score !== null ? Math.round(audit.score * 100) : null
      });
    }
  }

  return {
    score,
    accessibility,
    bestPractices,
    seo,
    fcp:          metric('first-contentful-paint'),
    si:           metric('speed-index'),
    lcp:          metric('largest-contentful-paint'),
    tbt:          metric('total-blocking-time'),
    cls:          metric('cumulative-layout-shift'),
    tti:          metric('interactive'),
    opportunities,
    diagnostics
  };
}

// ── Private: finding generation ───────────────────────────────────

/**
 * Generates findings from parsed Lighthouse metrics.
 * Only pushes findings for metrics that failed their thresholds.
 *
 * @param {Object[]}           findings
 * @param {Object}             data   - Normalised metrics from parseLighthouseJson
 * @param {'desktop'|'mobile'} device
 */
function generateFindings(findings, data, device) {
  const label = device === 'desktop' ? 'Desktop' : 'Mobile';

  // Overall score — only flag if critically low (< 50)
  if (data.score !== null && data.score < 50) {
    findings.push(createFinding({
      id:             `lighthouse-${device}-score-critical`,
      runner:         RUNNER_NAME,
      category:       CATEGORY.PERFORMANCE,
      severity:       SEVERITY.HIGH,
      title:          `${label} performance score is critically low (${data.score}/100)`,
      detail:         `A Lighthouse performance score below 50 indicates severe issues affecting page load speed, SEO rankings, and user experience.`,
      evidence:       `Lighthouse ${device} score: ${data.score}/100`,
      recommendation: 'Address all high-impact opportunities. Start with LCP, TBT, and render-blocking resources.',
      owasp:          null,
      wcag:           null
    }));
  }

  // LCP — most important Core Web Vital for SEO
  checkMs(findings, device, 'lcp', data.lcp, THRESHOLDS.lcp,
    'Largest Contentful Paint (LCP)',
    'LCP measures when the largest visible content element loads. It directly impacts perceived page speed and Google SEO ranking.',
    'Optimise images with modern formats (WebP/AVIF), use a CDN, and eliminate render-blocking resources.'
  );

  // TBT — proxy for First Input Delay (interactivity)
  checkMs(findings, device, 'tbt', data.tbt, THRESHOLDS.tbt,
    'Total Blocking Time (TBT)',
    'TBT measures how long the main thread was blocked between FCP and TTI. High TBT means the page feels unresponsive to user interactions.',
    'Reduce JavaScript execution time, split long tasks, and defer third-party scripts.'
  );

  // CLS — visual stability
  checkCls(findings, device, data.cls);

  // FCP — only flag if poor (slow initial render)
  if (data.fcp.value !== null && data.fcp.value >= THRESHOLDS.fcp.poor) {
    findings.push(createFinding({
      id:             `lighthouse-${device}-fcp-poor`,
      runner:         RUNNER_NAME,
      category:       CATEGORY.PERFORMANCE,
      severity:       SEVERITY.MEDIUM,
      title:          `${label} First Contentful Paint is slow (${data.fcp.displayValue})`,
      detail:         `FCP marks the first time any text or image is painted. A value of ${data.fcp.displayValue} indicates a slow server response or render-blocking resources.`,
      evidence:       `FCP: ${data.fcp.value}ms | Poor threshold: ${THRESHOLDS.fcp.poor}ms`,
      recommendation: 'Minimise render-blocking CSS/JS, use server-side caching, and reduce Time to First Byte (TTFB).',
      owasp:          null,
      wcag:           null
    }));
  }
}

/**
 * Checks a millisecond-based metric against thresholds and creates a finding.
 */
function checkMs(findings, device, key, metricData, threshold, name, detail, recommendation) {
  if (metricData.value === null) return;
  const label = device === 'desktop' ? 'Desktop' : 'Mobile';
  const v     = metricData.value;
  const d     = metricData.displayValue;

  if (v >= threshold.poor) {
    findings.push(createFinding({
      id:             `lighthouse-${device}-${key}-poor`,
      runner:         RUNNER_NAME,
      category:       CATEGORY.PERFORMANCE,
      severity:       SEVERITY.HIGH,
      title:          `${label} ${name} is poor (${d})`,
      detail:         `${detail} Value of ${d} exceeds the poor threshold of ${threshold.poor}ms.`,
      evidence:       `${key.toUpperCase()}: ${v}ms | Poor > ${threshold.poor}ms | Good < ${threshold.good}ms`,
      recommendation,
      owasp:          null,
      wcag:           null
    }));
  } else if (v >= threshold.good) {
    findings.push(createFinding({
      id:             `lighthouse-${device}-${key}-needs-improvement`,
      runner:         RUNNER_NAME,
      category:       CATEGORY.PERFORMANCE,
      severity:       SEVERITY.MEDIUM,
      title:          `${label} ${name} needs improvement (${d})`,
      detail:         `${detail} Value of ${d} is in the "needs improvement" range.`,
      evidence:       `${key.toUpperCase()}: ${v}ms | Range: ${threshold.good}ms – ${threshold.poor}ms`,
      recommendation,
      owasp:          null,
      wcag:           null
    }));
  }
}

/**
 * Checks CLS (unitless) against thresholds and creates a finding.
 */
function checkCls(findings, device, clsData) {
  if (clsData.value === null) return;
  const label = device === 'desktop' ? 'Desktop' : 'Mobile';
  const v     = clsData.value;
  const t     = THRESHOLDS.cls;

  if (v >= t.poor) {
    findings.push(createFinding({
      id:             `lighthouse-${device}-cls-poor`,
      runner:         RUNNER_NAME,
      category:       CATEGORY.PERFORMANCE,
      severity:       SEVERITY.HIGH,
      title:          `${label} Cumulative Layout Shift (CLS) is poor (${v})`,
      detail:         `CLS measures visual stability. A score of ${v} means significant content shifts during load, frustrating users and hurting Core Web Vitals.`,
      evidence:       `CLS: ${v} | Poor ≥ ${t.poor}`,
      recommendation: 'Set explicit width/height on all images and videos. Reserve space for ads, embeds, and dynamic content. Avoid inserting content above existing page content.',
      owasp:          null,
      wcag:           null
    }));
  } else if (v >= t.good) {
    findings.push(createFinding({
      id:             `lighthouse-${device}-cls-needs-improvement`,
      runner:         RUNNER_NAME,
      category:       CATEGORY.PERFORMANCE,
      severity:       SEVERITY.MEDIUM,
      title:          `${label} Cumulative Layout Shift (CLS) needs improvement (${v})`,
      detail:         `CLS of ${v} indicates some layout instability during page load. This can be jarring, especially on slower connections.`,
      evidence:       `CLS: ${v} | Range: ${t.good} – ${t.poor}`,
      recommendation: 'Use Chrome DevTools Layout Shift attribution to identify which elements are shifting and fix their dimensions.',
      owasp:          null,
      wcag:           null
    }));
  }
}
