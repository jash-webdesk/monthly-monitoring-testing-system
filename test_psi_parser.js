import { chromium } from 'playwright';

async function runPageSpeedInsights(targetUrl, strategy) {
  console.log(`Running PSI for ${targetUrl} on ${strategy}...`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 1000 });
  
  const psiUrl = `https://pagespeed.web.dev/report?url=${encodeURIComponent(targetUrl)}&form_factor=${strategy}`;
  await page.goto(psiUrl, { waitUntil: 'networkidle', timeout: 90000 });
  
  // Wait for score elements to attach
  await page.waitForSelector('a[href="#performance"]', { state: 'attached', timeout: 60000 });
  
  // Wait a bit to ensure text contents are loaded
  await page.waitForTimeout(3000);
  
  const result = await page.evaluate(() => {
    const getScore = (href) => {
      const el = document.querySelector(`a[href="${href}"]`);
      if (!el) return null;
      const text = el.innerText || '';
      const match = text.match(/^(\d+)/);
      return match ? parseInt(match[1]) : null;
    };

    // Find the text containing CWV metrics
    let metricsText = '';
    const divs = document.querySelectorAll('div, section, article');
    for (const div of divs) {
      const text = div.innerText || '';
      if (text.includes('First Contentful Paint') && text.includes('Largest Contentful Paint') && text.includes('Total Blocking Time')) {
        if (!metricsText || text.length < metricsText.length) {
          metricsText = text;
        }
      }
    }
    
    return {
      performance: getScore('#performance'),
      accessibility: getScore('#accessibility'),
      bestPractices: getScore('#best-practices'),
      seo: getScore('#seo'),
      metricsText: metricsText.replace(/\s+/g, ' ').slice(0, 300)
    };
  });
  
  await browser.close();
  
  // Parse metrics using regex
  const metrics = {};
  const fcpMatch = result.metricsText.match(/First Contentful Paint\s*([\d\.]+\s*s)/i);
  const lcpMatch = result.metricsText.match(/Largest Contentful Paint\s*([\d\.]+\s*s)/i);
  const tbtMatch = result.metricsText.match(/Total Blocking Time\s*([\d\.]+\s*ms)/i);
  const clsMatch = result.metricsText.match(/Cumulative Layout Shift\s*([\d\.]+)/i);
  
  metrics.fcp = fcpMatch ? fcpMatch[1] : 'N/A';
  metrics.lcp = lcpMatch ? lcpMatch[1] : 'N/A';
  metrics.tbt = tbtMatch ? tbtMatch[1] : 'N/A';
  metrics.cls = clsMatch ? clsMatch[1] : 'N/A';
  
  return {
    scores: {
      performance: result.performance,
      accessibility: result.accessibility,
      bestPractices: result.bestPractices,
      seo: result.seo
    },
    metrics
  };
}

(async () => {
  try {
    const mobile = await runPageSpeedInsights('https://partsconnexion.com/', 'mobile');
    console.log('Mobile Result:', mobile);
    
    const desktop = await runPageSpeedInsights('https://partsconnexion.com/', 'desktop');
    console.log('Desktop Result:', desktop);
  } catch (err) {
    console.error('Error:', err.message);
  }
})();
