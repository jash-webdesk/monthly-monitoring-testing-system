import { chromium } from 'playwright';

async function getScores(url, factor) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 1000 });
  
  const psiUrl = `https://pagespeed.web.dev/report?url=${encodeURIComponent(url)}&form_factor=${factor}`;
  console.log(`Navigating to ${psiUrl}...`);
  await page.goto(psiUrl, { waitUntil: 'networkidle', timeout: 90000 });
  
  console.log('Waiting for score elements...');
  await page.waitForSelector('a[href="#performance"]', { timeout: 60000 });
  
  const scores = await page.evaluate(() => {
    const getVal = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const text = el.innerText || '';
      const match = text.match(/^(\d+)/);
      return match ? parseInt(match[1]) : null;
    };
    return {
      performance: getVal('a[href="#performance"]'),
      accessibility: getVal('a[href="#accessibility"]'),
      bestPractices: getVal('a[href="#best-practices"]'),
      seo: getVal('a[href="#seo"]'),
    };
  });
  
  await browser.close();
  return scores;
}

(async () => {
  try {
    const scores = await getScores('https://audio-connexion.com/', 'desktop');
    console.log('AudioConnexion Desktop Scores:', scores);
  } catch (err) {
    console.error('Error:', err.message);
  }
})();
