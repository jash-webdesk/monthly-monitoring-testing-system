import test from 'node:test';
import assert from 'node:assert/strict';
import { runUptime } from '../../runners/uptime.runner.js';

const TARGET = 'https://genpet.org/';

function stubFetch(monitors, calls) {
  return async (url, opts = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('api.uptimerobot.com/v2/getMonitors')) {
      return { ok: true, status: 200, json: async () => ({ stat: 'ok', monitors }) };
    }
    if (u.includes('api.uptimerobot.com/v2/newMonitor')) {
      return { ok: true, status: 200, json: async () => ({ stat: 'fail', error: { message: 'plan limit' } }) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
  };
}

async function withEnv(vars, fn) {
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
    Object.assign(process.env, saved);
    globalThis.fetch = savedFetch;
  }
}

test('uptime: matched monitor gives a 30-day percentage and no "not linked" finding', async () => {
  const calls = [];
  const monitors = [{ url: 'https://genpet.org/', status: 2, custom_uptime_ratio: '100.000', response_times: [] }];
  const r = await withEnv({ UPTIMEROBOT_API_KEY: 'k', UPTIMEROBOT_AUTO_CREATE: undefined }, async () => {
    globalThis.fetch = stubFetch(monitors, calls);
    return runUptime(TARGET);
  });
  assert.equal(r.metrics.uptimePercentage, 100);
  assert.equal(r.metrics.uptimeSource, 'uptimerobot');
  assert.ok(!r.findings.some(f => f.id === 'uptime-not-linked'));
});

test('uptime: no matching monitor -> no % , flagged finding, and no monitor is created by default', async () => {
  const calls = [];
  const monitors = [{ url: 'https://other.example/', status: 2, custom_uptime_ratio: '99', response_times: [] }];
  const r = await withEnv({ UPTIMEROBOT_API_KEY: 'k', UPTIMEROBOT_AUTO_CREATE: undefined }, async () => {
    globalThis.fetch = stubFetch(monitors, calls);
    return runUptime(TARGET);
  });
  assert.equal(r.metrics.uptimePercentage, null);
  assert.equal(r.metrics.uptimeSource, 'live-probe');
  assert.ok(r.findings.some(f => f.id === 'uptime-not-linked'));
  assert.ok(!calls.some(u => u.includes('/v2/newMonitor')), 'newMonitor must not be called without UPTIMEROBOT_AUTO_CREATE=1');
});

test('uptime: UPTIMEROBOT_AUTO_CREATE=1 attempts registration when no monitor matches', async () => {
  const calls = [];
  await withEnv({ UPTIMEROBOT_API_KEY: 'k', UPTIMEROBOT_AUTO_CREATE: '1' }, async () => {
    globalThis.fetch = stubFetch([], calls);
    return runUptime(TARGET);
  });
  assert.ok(calls.some(u => u.includes('/v2/newMonitor')));
});

test('uptime: without an API key the finding says why', async () => {
  const r = await withEnv({ UPTIMEROBOT_API_KEY: undefined }, async () => {
    globalThis.fetch = stubFetch([], []);
    return runUptime(TARGET);
  });
  assert.equal(r.metrics.uptimeSource, 'live-probe');
  const f = r.findings.find(x => x.id === 'uptime-not-linked');
  assert.ok(f && f.detail.includes('UPTIMEROBOT_API_KEY is not set'));
});
