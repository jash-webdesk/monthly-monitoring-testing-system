import { createFinding, createErrorFinding, createRunnerResult, SEVERITY, CATEGORY } from '../lib/result.js';
import { logger } from '../lib/logger.js';

const RUNNER_NAME = 'uptime';

/**
 * Runs the Uptime snapshot runner for a URL.
 * If UPTIMEROBOT_API_KEY is defined in environment, queries UptimeRobot API.
 * Otherwise, performs on-demand synthetic checks.
 *
 * @param {string} targetUrl - Domain or URL to check e.g. "https://partsconnexion.com/"
 * @returns {Promise<Object>} Runner result envelope
 */
export async function runUptime(targetUrl) {
  logger.runnerStart(RUNNER_NAME);

  let hostname;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch (err) {
    const result = createRunnerResult(RUNNER_NAME, targetUrl, [
      createErrorFinding(RUNNER_NAME, `Invalid URL: ${err.message}`)
    ]);
    logger.runnerDone(RUNNER_NAME, 1);
    return result;
  }

  const findings = [];
  const metrics = {
    hostname,
    targetUrl,
    uptimePercentage: null,
    responseTimeMs: null,
    downtimeMinutes: null,
    status: 'unknown',
    redirectsCount: 0,
    tlsHandshakeMs: null,
    apiLinked: false
  };

  const apiKey = process.env.UPTIMEROBOT_API_KEY;

  if (apiKey) {
    try {
      logger.info('  UPTIMEROBOT_API_KEY found. Fetching historical log data...');
      const response = await fetch('https://api.uptimerobot.com/v2/getMonitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          custom_uptime_ratios: '30',
          response_times: 1
        })
      });

      if (!response.ok) {
        throw new Error(`UptimeRobot returned status ${response.status}`);
      }

      const data = await response.json();
      if (data.stat === 'ok' && Array.isArray(data.monitors)) {
        let monitor = data.monitors.find(m => m.url.includes(hostname));
        if (!monitor) {
          logger.info(`  No UptimeRobot monitor found matching hostname "${hostname}". Registering a new monitor...`);
          try {
            const createRes = await fetch('https://api.uptimerobot.com/v2/newMonitor', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                api_key: apiKey,
                friendly_name: hostname,
                url: targetUrl,
                type: 1 // HTTP check
              })
            });
            const createData = await createRes.json();
            if (createData.stat === 'ok' && createData.monitor) {
              logger.success(`  Successfully created new UptimeRobot monitor for ${hostname}!`);
              monitor = createData.monitor;
              monitor.custom_uptime_ratio = '100';
              monitor.status = 2; // Up
              monitor.response_times = [];
            } else {
              logger.warn(`  Auto-registration failed: ${createData.error?.message || 'Unknown error'}`);
            }
          } catch (createErr) {
            logger.warn(`  Auto-registration request failed: ${createErr.message}`);
          }
        }

        if (monitor && monitor.status !== 0) {
          metrics.apiLinked = true;
          metrics.uptimePercentage = parseFloat(monitor.custom_uptime_ratio) || 100.0;
          metrics.status = (monitor.status === 2 || monitor.status === 1) ? 'up' : 'down';
          
          // Get average response time
          if (Array.isArray(monitor.response_times) && monitor.response_times.length > 0) {
            const total = monitor.response_times.reduce((acc, curr) => acc + curr.value, 0);
            metrics.responseTimeMs = Math.round(total / monitor.response_times.length);
          }

          // Calculate approximate downtime minutes in 30 days
          metrics.downtimeMinutes = Math.round((1 - (metrics.uptimePercentage / 100)) * 30 * 24 * 60);

          logger.success(`  Matched UptimeRobot monitor: "${monitor.friendly_name}". 30-day Uptime: ${metrics.uptimePercentage}%`);
        } else {
          logger.warn(`  UptimeRobot monitor for "${hostname}" is paused or unmonitored. Falling back to synthetic live verification.`);
        }
      } else {
        throw new Error(data.error?.message || 'Invalid API key or status');
      }
    } catch (err) {
      logger.warn(`  UptimeRobot API query failed: ${err.message}. Falling back to synthetic verification.`);
    }
  }

  // Perform synthetic HTTP check to measure live metrics
  try {
    logger.info(`  Performing live synthetic uptime verify for ${targetUrl}...`);
    const start = Date.now();
    
    // We try to fetch the target URL
    const res = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'manual', // We trace redirects manually
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebDeskUptimeRunner/1.0' }
    });

    const elapsed = Date.now() - start;
    if (metrics.responseTimeMs === null) {
      metrics.responseTimeMs = elapsed;
    }
    
    if (metrics.status === 'unknown') {
      metrics.status = res.status >= 200 && res.status < 400 ? 'up' : 'down';
    }

    // Verify Redirects
    let currentUrl = targetUrl;
    let redirectCount = 0;
    let nextRes = res;
    
    while (nextRes.status >= 300 && nextRes.status < 400 && redirectCount < 5) {
      redirectCount++;
      const location = nextRes.headers.get('location');
      if (!location) break;
      
      currentUrl = new URL(location, currentUrl).href;
      nextRes = await fetch(currentUrl, { method: 'GET', redirect: 'manual' });
    }

    metrics.redirectsCount = redirectCount;

  } catch (err) {
    if (metrics.status === 'unknown') {
      metrics.status = 'down';
    }
    findings.push(createFinding({
      id:             'uptime-connection-failed',
      runner:         RUNNER_NAME,
      category:       CATEGORY.UPTIME,
      severity:       SEVERITY.CRITICAL,
      title:          'Website connection failed',
      detail:         `An automated connection attempt to ${targetUrl} failed completely. The server may be offline or misconfigured.`,
      evidence:       `Connection error: ${err.message}`,
      recommendation: 'Check hosting provider status and DNS configuration immediately.'
    }));
  }

  // ── Analyze Metrics & Generate Findings ─────────────────────────
  if (metrics.status === 'down') {
    findings.push(createFinding({
      id:             'uptime-site-currently-down',
      runner:         RUNNER_NAME,
      category:       CATEGORY.UPTIME,
      severity:       SEVERITY.CRITICAL,
      title:          'Website is currently down',
      detail:         `Automated probes confirm that ${hostname} is unreachable or returning server-side errors. Immediate intervention is required.`,
      evidence:       `Status code: Down`,
      recommendation: 'Check server logs and restart hosting environment immediately.'
    }));
  }

  // Validate availability thresholds (if we have API history)
  if (metrics.uptimePercentage !== null) {
    if (metrics.uptimePercentage < 99.0) {
      findings.push(createFinding({
        id:             'uptime-availability-critical',
        runner:         RUNNER_NAME,
        category:       CATEGORY.UPTIME,
        severity:       SEVERITY.HIGH,
        title:          `Uptime is below threshold (${metrics.uptimePercentage}%)`,
        detail:         `Uptime for the past 30 days is ${metrics.uptimePercentage}%, which is below the acceptable ecommerce threshold of 99.5%. This indicates recurrent, unresolved server outages.`,
        evidence:       `Uptime ratio: ${metrics.uptimePercentage}% (${metrics.downtimeMinutes} minutes downtime)`,
        recommendation: 'Audit server reliability and consult with hosting provider to optimize stability.'
      }));
    } else if (metrics.uptimePercentage < 99.5) {
      findings.push(createFinding({
        id:             'uptime-availability-warning',
        runner:         RUNNER_NAME,
        category:       CATEGORY.UPTIME,
        severity:       SEVERITY.MEDIUM,
        title:          `Uptime requires optimization (${metrics.uptimePercentage}%)`,
        detail:         `Uptime for the past 30 days is ${metrics.uptimePercentage}%. While functional, ecommerce sites should maintain >99.5% uptime to protect sales and search ranking.`,
        evidence:       `Uptime ratio: ${metrics.uptimePercentage}%`,
        recommendation: 'Investigate system event log files during reported down events.'
      }));
    }
  }

  // Check response time latency
  if (metrics.responseTimeMs > 2000) {
    findings.push(createFinding({
      id:             'uptime-response-latency-high',
      runner:         RUNNER_NAME,
      category:       CATEGORY.UPTIME,
      severity:       SEVERITY.MEDIUM,
      title:          `High server response latency (${metrics.responseTimeMs}ms)`,
      detail:         `The server took ${metrics.responseTimeMs}ms to respond. Slow server response (TTFB) directly hurts search engine crawling speed and initial page loads.`,
      evidence:       `First-response latency: ${metrics.responseTimeMs}ms`,
      recommendation: 'Enable cache layers (like Varnish or Redis) and check database query loads.'
    }));
  }

  const result = createRunnerResult(RUNNER_NAME, targetUrl, findings, metrics);
  logger.runnerDone(RUNNER_NAME, findings.length);
  return result;
}
