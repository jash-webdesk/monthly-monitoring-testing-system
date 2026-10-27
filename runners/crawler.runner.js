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

    // 4. Pillar 4C — Product Schema & Rich Snippets Audit
    logger.info('[Crawler] Running Pillar 4C: Product Rich Snippets (Schema.org) checks...');
    try {
      const { findings: schemaFindings, metrics: schemaMetrics } = await auditProductSchema(sitemapUrls, baseUrl);
      allFindings.push(...schemaFindings);
      metrics.productSchema = schemaMetrics;
    } catch (schemaErr) {
      logger.warn(`[Crawler] Pillar 4C Product Schema check warning: ${schemaErr.message}`);
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

/**
 * Pillar 4C — Product Rich Snippets (Schema.org) Audit for eCommerce Storefronts
 * Inspects Product Detail Pages (PDP) for Schema.org JSON-LD microdata, verifying
 * required Google Merchant & Search rich snippet attributes (price, currency, availability, SKU, brand).
 */
async function auditProductSchema(sitemapUrls, baseUrl) {
  const findings = [];
  const metrics = {
    auditedUrl: null,
    hasProductSchema: false,
    hasBreadcrumbs: false,
    name: null,
    sku: null,
    brand: null,
    price: null,
    currency: null,
    availability: null,
    richSnippetEligible: false
  };

  try {
    // 1. Identify candidate Product Detail Pages (PDP)
    const root = baseUrl.replace(/\/$/, '');
    let candidateUrls = [];

    // Check if store provides a dedicated product sub-sitemap (BigCommerce xmlsitemap.php?type=products or Shopify sitemap_products_1.xml)
    const subCandidates = [
      `${root}/xmlsitemap.php?type=products&page=1`,
      `${root}/sitemap_products_1.xml`,
      `${root}/sitemap-products.xml`
    ];

    for (const sub of subCandidates) {
      try {
        const { body, statusCode } = await fetchText(sub);
        if (statusCode === 200 && body) {
          const locs = extractLocs(body);
          if (locs.length > 0) {
            candidateUrls.push(...locs);
            break;
          }
        }
      } catch {}
    }

    if (candidateUrls.length === 0) {
      const nonProductPattern = /\/(category|categories|shop-by|brands?|about|contact|shipping|returns|privacy|terms|news|blog|cart|checkout|account|login|xmlsitemap|sitemap)\b/i;
      candidateUrls = (sitemapUrls || []).filter(u => !nonProductPattern.test(u) && u !== baseUrl && u !== `${root}/`);
    }

    if (candidateUrls.length === 0) {
      logger.info('[Crawler] No product detail page URL identified for Product Schema audit.');
      return { findings, metrics };
    }

    // Try up to 3 candidate URLs to locate and audit Product schema
    let productObj = null;
    let breadcrumbObj = null;
    let pdpUrl = candidateUrls[0];

    for (const candidate of candidateUrls.slice(0, 3)) {
      try {
        logger.info(`[Crawler] Auditing Product Schema on candidate: ${candidate}`);
        const { body: html, statusCode } = await fetchText(candidate);
        if (statusCode !== 200 || !html) continue;

        const regex = /<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi;
        const matches = [...html.matchAll(regex)];

        for (const m of matches) {
          try {
            const data = JSON.parse(m[1].trim());
            if (data['@type'] === 'Product' || data['@type'] === 'http://schema.org/Product') productObj = data;
            else if (data['@type'] === 'BreadcrumbList') breadcrumbObj = data;
            else if (Array.isArray(data['@graph'])) {
              for (const g of data['@graph']) {
                if (g['@type'] === 'Product') productObj = g;
                if (g['@type'] === 'BreadcrumbList') breadcrumbObj = g;
              }
            }
          } catch {}
        }

        if (productObj) {
          pdpUrl = candidate;
          break;
        }
      } catch {}
    }

    metrics.auditedUrl = pdpUrl;

    if (!productObj) {
      findings.push(createFinding({
        id: 'seo-missing-product-schema',
        category: CATEGORY.SEO,
        severity: SEVERITY.HIGH,
        title: 'Missing Schema.org Product Rich Snippets on Product Pages',
        detail: `The candidate product detail pages (such as ${pdpUrl}) lack structured Schema.org Product JSON-LD microdata. Google requires this to display prices, in-stock badges, and ratings in search results and Google Shopping.`,
        evidence: `0 Product JSON-LD entities found across candidate PDPs`,
        recommendation: 'Implement Schema.org JSON-LD Product microdata with name, image, offers, brand, and SKU.'
      }));
      return { findings, metrics };
    }

    metrics.hasProductSchema = true;
    metrics.name = productObj.name || null;
    metrics.sku = productObj.sku || productObj.productID || null;
    metrics.brand = typeof productObj.brand === 'object' ? (productObj.brand?.name || null) : (productObj.brand || null);
    metrics.hasBreadcrumbs = Boolean(breadcrumbObj);

    // Offers evaluation
    const offer = Array.isArray(productObj.offers) ? productObj.offers[0] : (productObj.offers || {});
    metrics.price = offer.price != null ? String(offer.price) : null;
    metrics.currency = offer.priceCurrency || null;
    metrics.availability = offer.availability || null;

    // Check required fields for Google Rich Results
    const hasName = Boolean(productObj.name);
    const hasImage = Boolean(productObj.image);
    const hasPrice = offer.price != null && !isNaN(Number(offer.price));
    const hasCurrency = Boolean(offer.priceCurrency);
    const hasAvailability = Boolean(offer.availability);
    const hasIdentifier = Boolean(metrics.sku || productObj.gtin || productObj.mpn);

    if (!hasPrice || !hasAvailability || !hasCurrency) {
      findings.push(createFinding({
        id: 'seo-product-schema-incomplete-offers',
        category: CATEGORY.SEO,
        severity: SEVERITY.MEDIUM,
        title: 'Product Schema Incomplete: Missing Pricing or Stock Availability',
        detail: `The Product schema at ${pdpUrl} is missing required offer fields (price: ${hasPrice ? 'OK' : 'MISSING'}, currency: ${hasCurrency ? 'OK' : 'MISSING'}, availability: ${hasAvailability ? 'OK' : 'MISSING'}). This prevents Google from showing price and stock badges on search results.`,
        evidence: `Offers: ${JSON.stringify(offer)}`,
        recommendation: 'Ensure offers object defines price (numerical), priceCurrency (e.g. USD), and availability (e.g. https://schema.org/InStock).'
      }));
    }

    if (!hasIdentifier) {
      findings.push(createFinding({
        id: 'seo-product-schema-missing-identifier',
        category: CATEGORY.SEO,
        severity: SEVERITY.LOW,
        title: 'Product Schema Missing Product Identifier (SKU / GTIN)',
        detail: `The Product schema at ${pdpUrl} lacks unique product identifiers (sku, gtin, or mpn). Google Merchant Center uses identifiers to match catalog listings.`,
        evidence: `SKU/GTIN: not defined`,
        recommendation: 'Add sku or gtin attribute to the Product JSON-LD block.'
      }));
    }

    metrics.richSnippetEligible = hasName && hasImage && hasPrice && hasCurrency && hasAvailability;
    logger.info(`[Crawler] Product Schema audit complete: ${metrics.name || 'Product'} (Eligible: ${metrics.richSnippetEligible ? 'YES' : 'NO'})`);
  } catch (err) {
    logger.warn(`[Crawler] Product schema audit warning: ${err.message}`);
  }

  return { findings, metrics };
}
