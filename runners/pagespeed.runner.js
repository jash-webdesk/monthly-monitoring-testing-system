import { logger } from '../lib/logger.js';

/**
 * Runs PageSpeed Insights via Google's online API using the PAGESPEED_API_KEY.
 * Returns scores and CWV metrics.
 * 
 * @param {string} targetUrl 
 * @param {string} strategy - "desktop" | "mobile"
 * @returns {Promise<Object>}
 */
export async function runPagespeed(targetUrl, strategy) {
  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    throw new Error('PAGESPEED_API_KEY environment variable is not defined in .env');
  }

  logger.info(`Requesting PageSpeed Insights for ${targetUrl} (${strategy})...`);
  const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(targetUrl)}&strategy=${strategy}&key=${apiKey}`;

  try {
    const res = await fetch(url);
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

    const scores = {
      performance: Math.round((lh.categories.performance?.score ?? 0) * 100),
      accessibility: Math.round((lh.categories.accessibility?.score ?? 0) * 100),
      bestPractices: Math.round((lh.categories['best-practices']?.score ?? 0) * 100),
      seo: Math.round((lh.categories.seo?.score ?? 0) * 100),
    };

    const metrics = {
      fcp: { displayValue: lh.audits['first-contentful-paint']?.displayValue ?? 'N/A' },
      lcp: { displayValue: lh.audits['largest-contentful-paint']?.displayValue ?? 'N/A' },
      tbt: { displayValue: lh.audits['total-blocking-time']?.displayValue ?? 'N/A' },
      cls: { displayValue: lh.audits['cumulative-layout-shift']?.displayValue ?? 'N/A' },
    };

    logger.success(`PSI ${strategy} successfully fetched. Performance: ${scores.performance}`);
    return { scores, metrics };
  } catch (err) {
    logger.runnerError('pagespeed', `API fetch failed: ${err.message}`);
    throw err;
  }
}
