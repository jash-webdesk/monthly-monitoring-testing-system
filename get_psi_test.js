import { chromium } from 'playwright';

(async () => {
  console.log('Launching browser to check PageSpeed Insights...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Set window size
  await page.setViewportSize({ width: 1280, height: 1600 });
  
  const targetUrl = 'https://pagespeed.web.dev/report?url=https%3A%2F%2Fpartsconnexion.com%2F';
  console.log(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 90000 });
  
  // Wait for the gauge components to appear
  await page.waitForSelector('text=Performance', { timeout: 60000 });
  console.log('PageSpeed analysis page ready.');
  
  // Let's scroll down to ensure Lighthouse starts rendering / is fully loaded
  await page.evaluate(() => window.scrollTo(0, 1000));
  await page.waitForTimeout(2000);
  
  // Let's write a DOM evaluation to find the score gauges
  const scoreData = await page.evaluate(() => {
    const data = [];
    // Lighthouse gauges are typically inside a wrapper with class containing "lh-gauge__wrapper" or similar.
    // Or we can find elements by class names or SVG labels.
    // Let's inspect all classes containing "gauge"
    const elements = document.querySelectorAll('*');
    for (const el of elements) {
      const className = el.className || '';
      const clStr = typeof className === 'string' ? className : '';
      if (clStr.includes('gauge')) {
        data.push({
          tag: el.tagName,
          class: clStr,
          text: el.innerText ? el.innerText.trim().replace(/\s+/g, ' ') : '',
          html: el.innerHTML ? el.innerHTML.slice(0, 200) : ''
        });
      }
    }
    return data;
  });
  
  console.log('Found gauge elements in DOM:');
  console.log(JSON.stringify(scoreData.slice(0, 30), null, 2));
  
  // Let's take a screenshot of the scrolled page
  await page.screenshot({ path: 'C:/Users/jashm/.gemini/antigravity/brain/ebf32d25-f1c3-4819-8276-e2b05197a1b8/psi_scrolled.png' });
  console.log('Scrolled screenshot saved to psi_scrolled.png');
  
  await browser.close();
})();
