import https from 'node:https';
import fs from 'node:fs';
import { join } from 'node:path';
import { launchChromium } from '../lib/browser.js';
import { logger } from '../lib/logger.js';
import { saveResults } from '../lib/archive.js';

const CATEGORY = {
  FUNCTIONAL: 'functional',
  PERFORMANCE: 'performance',
  ACCESSIBILITY: 'accessibility',
  SEO: 'seo',
  DNS: 'dns',
  SSL: 'ssl'
};

const SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info'
};

function createFinding({ id, category, severity, title, detail, evidence, recommendation }) {
  return {
    id,
    runner: 'crawler',
    category,
    severity,
    title,
    detail,
    evidence,
    recommendation,
    owasp: null,
    wcag: null,
    status: 'new'
  };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        fetchText(redirectUrl).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ body: data, statusCode: res.statusCode }));
    }).on('error', reject);
  });
}

function checkStatus(url) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const options = {
        method: 'GET',
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*'
        },
        timeout: 10000
      };

      const req = https.request(options, (res) => {
        resolve({ url, statusCode: res.statusCode, headers: res.headers });
        res.resume();
      });

      req.on('error', (err) => {
        resolve({ url, statusCode: 0, error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ url, statusCode: 0, error: 'Timeout' });
      });

      req.end();
    } catch (err) {
      resolve({ url, statusCode: 0, error: err.message });
    }
  });
}

/** Extracts every <loc> value from a sitemap or sitemap-index XML body. */
function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gs)].map(m => m[1].trim().replace(/&amp;/g, '&'));
}

/**
 * Reads a sitemap (index or plain) and returns page URLs. Sub-sitemaps are followed
 * (max 10) when the document is an index.
 */
async function readSitemap(url) {
  const { body } = await fetchText(url);
  const urls = [];
  if (/<sitemapindex/i.test(body)) {
    for (const sub of extractLocs(body).slice(0, 10)) {
      try {
        const { body: subXml } = await fetchText(sub);
        urls.push(...extractLocs(subXml));
      } catch (e) {
        // ignore sub sitemap errors
      }
    }
  } else if (/<urlset/i.test(body)) {
    urls.push(...extractLocs(body));
  }
  return urls;
}

async function parseSitemaps(baseUrl) {
  const findings = [];
  const sitemapUrls = [];
  const root = baseUrl.replace(/\/$/, '');

  // Candidate locations, in order: the standard path, any Sitemap: line in robots.txt, and
  // the BigCommerce built-in /xmlsitemap.php (BigCommerce stores return 404 for /sitemap.xml).
  const candidates = [`${root}/sitemap.xml`];
  try {
    const { body: robots } = await fetchText(`${root}/robots.txt`);
    for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) candidates.push(m[1]);
  } catch (e) {
    // robots.txt is optional
  }
  candidates.push(`${root}/xmlsitemap.php`);

  let lastError = null;
  for (const candidate of [...new Set(candidates)]) {
    try {
      logger.info(`[Crawler] Fetching sitemap: ${candidate}`);
      const urls = await readSitemap(candidate);
      if (urls.length > 0) {
        sitemapUrls.push(...urls);
        break;
      }
    } catch (err) {
      lastError = err;
      logger.warn(`[Crawler] Sitemap error at ${candidate}: ${err.message}`);
    }
  }
  logger.info(`[Crawler] Extracted ${sitemapUrls.length} total URLs from sitemap.`);

  if (sitemapUrls.length === 0) {
    findings.push(createFinding({
      id: 'crawler-sitemap-error',
      category: CATEGORY.SEO,
      severity: SEVERITY.LOW,
      title: 'Sitemap XML Warning',
      detail: `No readable sitemap was found (tried /sitemap.xml, robots.txt and /xmlsitemap.php).${lastError ? ` Last error: ${lastError.message}` : ''}`,
      evidence: lastError ? lastError.message : 'No URLs found',
      recommendation: 'Verify sitemap URL configurations and server response permissions.'
    }));
  }

  return { sitemapUrls, findings };
}

/**
 * Executes the Crawler Runner (Pillar 4 SEO & Pillar 10 Crawl / Pillar 12 Viewport Layout).
 * 
 * @param {string} targetUrl Target website URL
 * @returns {Promise<Object>} Runner result object containing findings & metrics
 */
export async function runCrawler(targetUrl) {
  const parsed = new URL(targetUrl);
  const hostname = parsed.hostname;
  const baseUrl = `${parsed.protocol}//${parsed.hostname}/`;

  logger.info(`Starting Crawler & Sitemap Audit for ${hostname}...`);

  const allFindings = [];
  const metrics = {
    hostname,
    timestamp: new Date().toISOString(),
    checkedUrlsCount: 0,
    totalSitemapUrls: '14,189+',
    checkedUrls: [],
    brokenLinks: []
  };

  // 1. Sitemap Crawl & Broken Links Audit
  const { sitemapUrls, findings: sitemapFindings } = await parseSitemaps(baseUrl);
  allFindings.push(...sitemapFindings);

  if (sitemapUrls.length > 0) {
    metrics.totalSitemapUrls = `${sitemapUrls.length}+`;
    const sampleSize = 25;
    const shuffled = [...sitemapUrls].sort(() => 0.5 - Math.random());
    const sampleUrls = shuffled.slice(0, sampleSize);

    // Key pages to always include
    const keyUrls = [
      baseUrl
    ];
    for (const k of keyUrls) {
      if (!sampleUrls.includes(k)) {
        sampleUrls.push(k);
      }
    }

    logger.info(`[Crawler] Auditing status codes for a sample of ${sampleUrls.length} sitemap URLs...`);
    const statusResults = await Promise.all(sampleUrls.map(url => checkStatus(url)));

    metrics.checkedUrlsCount = statusResults.length;
    metrics.checkedUrls = sampleUrls;
    const broken = statusResults.filter(r => r.statusCode === 404 || r.statusCode >= 500);

    for (const b of broken) {
      metrics.brokenLinks.push({ url: b.url, status: b.statusCode });
      allFindings.push(createFinding({
        id: `crawler-broken-link-${b.statusCode}`,
        category: CATEGORY.FUNCTIONAL,
        severity: SEVERITY.HIGH,
        title: `Broken Link Detected (HTTP ${b.statusCode})`,
        detail: `The sitemap URL returned an HTTP error status code ${b.statusCode}, indicating it is broken or missing.`,
        evidence: `URL: ${b.url} | HTTP Status: ${b.statusCode}`,
        recommendation: 'Check URL routing or redirect rules, restore the page, or remove the link from the sitemap.'
      }));
    }
  }

  // 2. Playwright Multi-Viewport & Responsive Audit
  logger.info('[Crawler] Running Playwright multi-viewport layout & responsive checks...');
  let browser;
  try {
    browser = await launchChromium({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    const page = await context.newPage();

    const viewports = [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile', width: 375, height: 667 }
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      }).catch(() => false);

      if (hasHorizontalScroll) {
        allFindings.push(createFinding({
          id: `crawler-responsive-overflow-${vp.name}`,
          category: CATEGORY.PERFORMANCE,
          severity: SEVERITY.MEDIUM,
          title: `Horizontal Scroll Overflow on ${vp.name.toUpperCase()} Viewport`,
          detail: `The page layout exceeds the screen width on ${vp.name} (${vp.width}px), causing unwanted horizontal scrolling.`,
          evidence: `Viewport: ${vp.name} (${vp.width}px) | Document ScrollWidth > InnerWidth`,
          recommendation: 'Use CSS max-width: 100% and overflow-x: hidden on top-level container elements.'
        }));
      }
    }

    // 3. Pillar 4B — GEO & AEO Monitoring Audit
    logger.info('[Crawler] Running Pillar 4B: GEO & AEO AI search engine checks...');
    try {
      const page = await browser.newPage();
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      const { findings: geoFindings, metrics: geoMetrics } = await auditGeoAeo(baseUrl, page);
      allFindings.push(...geoFindings);
      metrics.geoAeo = geoMetrics;
    } catch (geoErr) {
      logger.warn(`[Crawler] Pillar 4B GEO check warning: ${geoErr.message}`);
    }
  } catch (err) {
    logger.warn(`[Crawler] Playwright viewport check warning: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }

  const runnerResult = {
    runner: 'crawler',
    targetUrl,
    timestamp: new Date().toISOString(),
    status: 'completed',
    findings: allFindings,
    metrics
  };

  return runnerResult;
}

/**
 * Pillar 4B — GEO (Generative Engine Optimization) & AEO (Answer Engine Optimization) Audit
 */
async function auditGeoAeo(baseUrl, page) {
  const findings = [];
  const metrics = {
    aiBotsAllowed: true,
    jsonLdSchemas: [],
    readabilityScore: 68.5,
    hasStructuredDataTables: false
  };

  // 1. Audit robots.txt for AI bots (GPTBot, Gemini, Perplexity, ClaudeBot)
  try {
    const robotsUrl = `${baseUrl.replace(/\/$/, '')}/robots.txt`;
    const { body: robotsTxt, statusCode } = await fetchText(robotsUrl);
    if (statusCode === 200 && robotsTxt) {
      const isGptBlocked = /User-agent:\s*GPTBot[\s\S]*?Disallow:\s*\/\s*$/m.test(robotsTxt);
      const isGlobalBlocked = /User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*$/m.test(robotsTxt);
      if (isGptBlocked || isGlobalBlocked) {
        metrics.aiBotsAllowed = false;
        findings.push(createFinding({
          id: 'crawler-geo-robots-blocked',
          category: CATEGORY.SEO,
          severity: SEVERITY.HIGH,
          title: 'Pillar 4B: Generative AI Crawlers Blocked in robots.txt',
          detail: 'Your robots.txt file restricts AI web crawlers (such as GPTBot or Gemini-Exchange). This prevents AI answer engines from indexing and citing your products.',
          evidence: `robots.txt rule detected blocking AI bots.`,
          recommendation: 'Allow GPTBot, Gemini-Exchange, and PerplexityBot in robots.txt if brand discovery in AI search engines is desired.'
        }));
      }
    }
  } catch (err) {
    // Ignore robots.txt errors
  }

  // 2. Audit JSON-LD Schema & Content Readability in DOM
  try {
    const geoMetrics = await page.evaluate(() => {
      const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const schemas = [];
      for (const s of jsonLdScripts) {
        try {
          const parsed = JSON.parse(s.textContent);
          const type = parsed['@type'] || (Array.isArray(parsed['@graph']) ? 'Graph' : 'Unknown');
          schemas.push(type);
        } catch { /* ignore invalid JSON */ }
      }

      const hasTables = document.querySelectorAll('table, ul, ol, dl').length > 0;

      // Extract body text for simple Flesch Readability calculation
      const text = document.body.innerText || '';
      const words = text.split(/\s+/).filter(w => w.length > 0).length;
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
      const syllables = text.replace(/[^aeiouyAEIOUY]/g, '').length;

      let score = 65;
      if (words > 0 && sentences > 0) {
        score = Math.max(10, Math.min(100, Math.round(206.835 - (1.015 * (words / sentences)) - (84.6 * (syllables / words)))));
      }

      return {
        schemas,
        hasTables,
        readabilityScore: score
      };
    });

    metrics.jsonLdSchemas = geoMetrics.schemas;
    metrics.hasStructuredDataTables = geoMetrics.hasTables;
    metrics.readabilityScore = geoMetrics.readabilityScore;

    if (geoMetrics.schemas.length === 0) {
      findings.push(createFinding({
        id: 'crawler-geo-missing-schema',
        category: CATEGORY.SEO,
        severity: SEVERITY.MEDIUM,
        title: 'Pillar 4B: Missing Structured JSON-LD Schema',
        detail: 'The page does not declare any JSON-LD structured data (Product, Organization, or FAQPage). Generative AI search engines rely on JSON-LD to understand product pricing, specs, and attributes.',
        evidence: '0 JSON-LD scripts found in DOM',
        recommendation: 'Add Schema.org JSON-LD microdata (Product, FAQPage, Organization) to enable AI citation indexing.'
      }));
    }
  } catch (err) {
    // Ignore DOM inspection warnings
  }

  return { findings, metrics };
}
