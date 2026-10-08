// Integration tests for the sandbox-compat network layer. They hit real public hosts
// (example.com, Cloudflare/Google DoH), so they need internet access:  node --test tests/integration/network.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';

// A tiny CONNECT proxy that records every tunnel it opens, to prove traffic really goes through it.
function startProxy() {
  const tunnels = [];
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':');
    tunnels.push(host);
    const upstream = net.connect(Number(port) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket); clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, tunnels, url: `http://127.0.0.1:${server.address().port}` })));
}

test('proxy: fetch, https.get and Chromium all tunnel through HTTPS_PROXY', async () => {
  const proxy = await startProxy();
  process.env.HTTPS_PROXY = proxy.url;
  try {
    const { installNetwork } = await import('../../lib/net.js');
    await installNetwork();

    const r1 = await fetch('https://example.com/');
    assert.equal(r1.status, 200);
    assert.ok(proxy.tunnels.includes('example.com'), 'fetch() did not use the proxy');

    const before = proxy.tunnels.length;
    await new Promise((resolve, reject) => https.get('https://example.org/', (res) => { res.resume(); res.on('end', resolve); }).on('error', reject));
    assert.ok(proxy.tunnels.length > before && proxy.tunnels.includes('example.org'), 'https.get() did not use the proxy');

    const { launchChromium } = await import('../../lib/browser.js');
    const browser = await launchChromium();
    try {
      const page = await browser.newPage();
      const resp = await page.goto('https://www.iana.org/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      assert.ok(resp.ok());
      assert.ok(proxy.tunnels.some((h) => h.endsWith('iana.org')), 'Chromium did not use the proxy');
    } finally { await browser.close(); }
  } finally {
    delete process.env.HTTPS_PROXY;
    const { resetNetwork } = await import('../../lib/net.js');
    await resetNetwork();
    proxy.server.close();
  }
});

test('dns: DNS-over-HTTPS answers match the native resolver for a stable domain', async () => {
  process.env.DNS_MODE = 'native';
  const native = (await import('node:dns/promises')).default;
  const { default: resolver } = await import('../../lib/resolver.js?native');
  const nativeNs = (await resolver.resolveNs('example.com')).map((s) => s.toLowerCase()).sort();
  delete process.env.DNS_MODE;

  process.env.DNS_MODE = 'doh';
  const { default: doh } = await import('../../lib/resolver.js?doh');
  const dohNs = (await doh.resolveNs('example.com')).map((s) => s.toLowerCase()).sort();
  const dohMx = await doh.resolveMx('gmail.com');
  const dohTxt = await doh.resolveTxt('google.com');
  delete process.env.DNS_MODE;

  assert.deepEqual(dohNs, nativeNs);
  assert.ok(dohMx.length > 0 && typeof dohMx[0].priority === 'number' && typeof dohMx[0].exchange === 'string');
  assert.ok(Array.isArray(dohTxt[0]) && dohTxt.flat().some((t) => t.startsWith('v=spf1')));
  assert.equal(typeof native.resolve4, 'function');
});

test('ssl: browser-based certificate read agrees with the raw TLS read', async () => {
  const { runSsl } = await import('../../runners/ssl.runner.js');
  process.env.SSL_MODE = 'native';
  const a = await runSsl('https://example.com/');
  process.env.SSL_MODE = 'browser';
  const b = await runSsl('https://example.com/');
  delete process.env.SSL_MODE;
  if (a.metrics.verdict === 'indeterminate') {
    // Behind a TLS-inspecting proxy the certificate belongs to the proxy: it must not be reported as the site's.
    assert.equal(b.metrics.verdict, 'indeterminate');
    assert.equal(a.metrics.certificate, undefined);
    assert.equal(b.metrics.certificate, undefined);
    assert.ok(a.findings.some((f) => f.id === 'ssl-tls-interception-indeterminate'));
    return;
  }
  assert.equal(a.metrics.certificate.source, 'tls');
  assert.equal(b.metrics.certificate.source, 'browser');
  assert.equal(new Date(a.metrics.certificate.validTo).getTime(), new Date(b.metrics.certificate.validTo).getTime(), 'expiry differs between methods');
  assert.equal(a.metrics.certificate.issuer, b.metrics.certificate.issuer);
});
