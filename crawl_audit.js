import https from 'node:https';
import fs from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

// Target URL
const TARGET_URL = 'https://www.lidstyles.com/';
const HOSTNAME = 'www.lidstyles.com';
const RUN_MONTH = '2026-07';

// Output Paths
const ARCHIVE_DIR = join(process.cwd(), 'results', HOSTNAME, RUN_MONTH);
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
const OUTPUT_FILE = join(ARCHIVE_DIR, 'crawl_audit_result.json');

// Standardized findings categories and helper
const CATEGORY = {
  FUNCTIONAL: 'functional',
  PERFORMANCE: 'performance',
  ACCESSIBILITY: 'accessibility',
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
    runner: 'crawl-audit',
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

// 1. Fetch Helper (HTTP client)
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Simple redirect support
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

// HTTP Head/Get request check for status validation
function checkStatus(url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const options = {
      method: 'GET', // Use GET to bypass some CDN blocks on HEAD
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
      res.resume(); // consume response to free memory
    });

    req.on('error', (err) => {
      resolve({ url, statusCode: 0, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ url, statusCode: 0, error: 'Timeout' });
    });

    req.end();
  });
}

// 2. Parse Sitemap
async function parseSitemaps() {
  console.log(`[Sitemap] Fetching index sitemap: ${TARGET_URL}sitemap.xml`);
  const findings = [];
  const sitemapUrls = [];
  
  try {
    const { body: indexXml } = await fetchText(`${TARGET_URL}sitemap.xml`);
    const locRegex = /<loc>(.*?)<\/loc>/g;
    let match;
    const subSitemaps = [];
    while ((match = locRegex.exec(indexXml)) !== null) {
      subSitemaps.push(match[1]);
    }
    
    console.log(`[Sitemap] Found ${subSitemaps.length} nested sub-sitemaps.`);
    
    for (const sub of subSitemaps) {
      console.log(`[Sitemap] Fetching and parsing: ${sub}`);
      const { body: subXml } = await fetchText(sub);
      let urlMatch;
      const subLocRegex = /<loc>(.*?)<\/loc>/g;
      while ((urlMatch = subLocRegex.exec(subXml)) !== null) {
        sitemapUrls.push(urlMatch[1]);
      }
    }
    console.log(`[Sitemap] Extracted ${sitemapUrls.length} total URLs.`);
  } catch (err) {
    console.error(`[Sitemap] Error: ${err.message}`);
    findings.push(createFinding({
      id: 'crawler-sitemap-error',
      category: CATEGORY.FUNCTIONAL,
      severity: SEVERITY.MEDIUM,
      title: 'Failed to download or parse sitemap index',
      detail: `The sitemap parser failed while loading sitemap.xml: ${err.message}`,
      evidence: err.message,
      recommendation: 'Verify sitemap URL configurations and server response permissions.'
    }));
  }
  
  return { sitemapUrls, findings };
}

// Main Runner Execution
async function run() {
  console.log('============================================================');
  console.log('  Crawl, UI/UX Responsive & Filter Standalone Audit');
  console.log('============================================================');

  const allFindings = [];
  const metrics = {
    hostname: HOSTNAME,
    timestamp: new Date().toISOString(),
    checkedUrlsCount: 0,
    brokenLinks: []
  };

  // --- Step 1: Sitemap Fetching & 404 Checks ---
  const { sitemapUrls, findings: sitemapFindings } = await parseSitemaps();
  allFindings.push(...sitemapFindings);

  if (sitemapUrls.length > 0) {
    // Select sample of 25 random URLs from sitemap links
    const sampleSize = 50; // Grab 50 representative URLs to check status
    const shuffled = [...sitemapUrls].sort(() => 0.5 - Math.random());
    const sampleUrls = shuffled.slice(0, sampleSize);
    
    // Add homepage and key pages to sample list to ensure they are always verified
    const keyUrls = [
      'https://www.lidstyles.com/',
      'https://www.lidstyles.com/blue-dell-e6400-laptop-skin.html',
      'https://www.lidstyles.com/shop-by-pattern/abstract.html',
      'https://www.lidstyles.com/customer-service'
    ];
    for (const keyUrl of keyUrls) {
      if (!sampleUrls.includes(keyUrl)) {
        sampleUrls.push(keyUrl);
      }
    }

    console.log(`[Crawl] Auditing status codes for a sample of ${sampleUrls.length} URLs...`);
    sampleUrls.forEach((url, i) => console.log(`  - Checking [${i + 1}/${sampleUrls.length}]: ${url}`));
    const statusResults = await Promise.all(sampleUrls.map(url => checkStatus(url)));
    
    metrics.checkedUrlsCount = statusResults.length;
    metrics.checkedUrls = sampleUrls;
    const broken = statusResults.filter(r => r.statusCode === 404 || r.statusCode >= 500);
    const redirects = statusResults.filter(r => r.statusCode === 301 || r.statusCode === 302);
    
    console.log(`[Crawl] Found ${broken.length} broken links and ${redirects.length} redirects.`);
    
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

  // --- Step 2: Playwright UI/UX Responsive & Filter Audit ---
  console.log('[Playwright] Starting responsive UI/UX and filter audits...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Target templates for responsive checks
  const templates = {
    homepage: 'https://www.lidstyles.com/',
    product: 'https://www.lidstyles.com/blue-dell-e6400-laptop-skin.html',
    category: 'https://www.lidstyles.com/shop-by-pattern/abstract.html',
    cms: 'https://www.lidstyles.com/customer-service'
  };

  const viewports = [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 375, height: 667 }
  ];

  try {
    for (const [tplName, tplUrl] of Object.entries(templates)) {
      console.log(`[Playwright] Auditing page template: ${tplName} (${tplUrl})`);
      
      // Load page
      let pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      await page.goto(tplUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(2000); // Allow scripts to execute

      // Check for JS exceptions on load
      if (pageErrors.length > 0) {
        allFindings.push(createFinding({
          id: `crawler-js-error-${tplName}`,
          category: CATEGORY.FUNCTIONAL,
          severity: SEVERITY.MEDIUM,
          title: `[${tplName.toUpperCase()}] JavaScript console errors detected on load`,
          detail: `${pageErrors.length} JavaScript runtime exception(s) occurred when loading this page template.`,
          evidence: pageErrors.join(' | '),
          recommendation: 'Review developer tools console logs and fix uncaught script exceptions.'
        }));
      }

      // Check responsive layout in each viewport
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.waitForTimeout(1000);

        // Responsive scroll width check (detecting horizontal layout overflow)
        const overflow = await page.evaluate(() => {
          const docWidth = document.documentElement.scrollWidth;
          const winWidth = window.innerWidth;
          return { overflow: docWidth > winWidth, docWidth, winWidth };
        });

        if (overflow.overflow) {
          allFindings.push(createFinding({
            id: `crawler-responsive-overflow-${tplName}-${vp.name}`,
            category: CATEGORY.FUNCTIONAL,
            severity: SEVERITY.MEDIUM,
            title: `[${tplName.toUpperCase()}] Layout horizontal overflow detected on ${vp.name}`,
            detail: `The page width (${overflow.docWidth}px) exceeds the viewport width (${overflow.winWidth}px) on ${vp.name}, causing unwanted horizontal scrolling and breaking responsive UX.`,
            evidence: `Viewport: ${vp.name} (${vp.width}px) | Document Width: ${overflow.docWidth}px`,
            recommendation: 'Set max-width: 100% on dynamic banner/image containers and resolve absolute margins.'
          }));
        }
      }
    }

    // --- Step 3: Layered Navigation Filter Check ---
    console.log('[Playwright] Testing category page layered navigation filters...');
    await page.goto(templates.category, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Click on the first filter link in .block.filter
    const filterLink = await page.$eval('.block.filter a', el => ({
      text: el.innerText.trim(),
      href: el.href
    })).catch(() => null);

    if (filterLink) {
      console.log(`[Playwright] Clicking filter option: "${filterLink.text}" linking to: ${filterLink.href}`);
      
      const response = await page.goto(filterLink.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status = response.status();
      console.log(`[Playwright] Filter page returned HTTP ${status}`);
      
      if (status !== 200) {
        allFindings.push(createFinding({
          id: 'crawler-filter-navigation-failed',
          category: CATEGORY.FUNCTIONAL,
          severity: SEVERITY.HIGH,
          title: 'Category layered filter navigation returns error status',
          detail: `Navigating to the layered filter URL "${filterLink.text}" returned HTTP ${status}.`,
          evidence: `Filter: ${filterLink.text} | URL: ${filterLink.href} | Status: ${status}`,
          recommendation: 'Check URL rewrites and sitemap indexes for filter routing configurations in Magento.'
        }));
      } else {
        console.log('[Playwright] Filter loaded successfully (HTTP 200).');
      }
    } else {
      console.warn('[Playwright] No layered filter links found on category page.');
    }

  } catch (err) {
    console.error(`[Playwright] Execution error: ${err.message}`);
    allFindings.push(createFinding({
      id: 'crawler-playwright-timeout',
      category: CATEGORY.FUNCTIONAL,
      severity: SEVERITY.MEDIUM,
      title: 'Responsive UI/UX check timed out',
      detail: `Playwright browser execution encountered an issue: ${err.message}`,
      evidence: err.message,
      recommendation: 'Verify server load and check network response times.'
    }));
  } finally {
    await browser.close();
    console.log('[Playwright] Browser closed.');
  }

  // --- Step 4: Save & Summarize Results ---
  const resultPayload = {
    runner: 'crawler-standalone',
    targetUrl: TARGET_URL,
    timestamp: metrics.timestamp,
    metrics,
    findings: allFindings
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(resultPayload, null, 2));
  console.log(`\n[Audit Complete] Standalone crawl audit saved to: ${OUTPUT_FILE}`);
  console.log(`Total findings captured: ${allFindings.length}`);
  
  console.log('\n=== STANDALONE AUDIT FINDINGS ===');
  if (allFindings.length === 0) {
    console.log('No layout, responsive, or crawling errors detected. All checks passed!');
  } else {
    allFindings.forEach((f, idx) => {
      console.log(`${idx + 1}. [${f.severity.toUpperCase()}] ${f.title}`);
      console.log(`   Evidence: ${f.evidence}`);
      console.log(`   Recommendation: ${f.recommendation}\n`);
    });
  }
}

run();
