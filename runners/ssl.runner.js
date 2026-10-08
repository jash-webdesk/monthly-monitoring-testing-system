import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { launchChromium } from '../lib/browser.js';
import { proxyUrl } from '../lib/net.js';
import { createFinding, createErrorFinding, createRunnerResult, SEVERITY, CATEGORY } from '../lib/result.js';
import { logger } from '../lib/logger.js';

const RUNNER_NAME  = 'ssl';
const DEFAULT_PORT = 443;
const TIMEOUT_MS   = 30000;

/**
 * Runs the SSL/TLS certificate runner for a given URL.
 * Uses Node.js built-in tls module — no external tools required.
 * Checks: expiry, hostname coverage, issuer, and SAN list.
 *
 * @param {string} url - Full URL e.g. "https://partsconnexion.com/"
 * @returns {Promise<Object>} Runner result envelope
 */
export async function runSsl(url) {
  logger.runnerStart(RUNNER_NAME);

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (err) {
    const result = createRunnerResult(RUNNER_NAME, url, [
      createErrorFinding(RUNNER_NAME, `Invalid URL provided: ${err.message}`)
    ]);
    logger.runnerDone(RUNNER_NAME, 1);
    return result;
  }

  const findings = [];
  const metrics  = { hostname, url };

  // Decide trust before reading any certificate. Behind a TLS-inspecting proxy the certificate that
  // the raw socket or the browser sees belongs to the proxy, not to the site, so it must not be reported.
  const trust = await checkTrust(hostname, DEFAULT_PORT);
  metrics.trust = trust.verdict;
  if (trust.verdict !== 'public' && isProxiedEnvironment()) {
    const indeterminate = indeterminateResult(url, hostname, trust);
    logger.runnerDone(RUNNER_NAME, indeterminate.findings.length);
    return indeterminate;
  }

  try {
    logger.debug(`Connecting to ${hostname}:${DEFAULT_PORT} for TLS inspection`);
    const cert = await getCertificateInfo(hostname, DEFAULT_PORT);
    metrics.certificate = cert;

    // ── Expiry Check ──────────────────────────────────────────────
    const expiryDate    = new Date(cert.validTo);
    const now           = new Date();
    const daysRemaining = Math.floor((expiryDate - now) / 86_400_000);
    metrics.daysUntilExpiry = daysRemaining;

    if (daysRemaining < 0) {
      findings.push(createFinding({
        id:             'ssl-cert-expired',
        runner:         RUNNER_NAME,
        category:       CATEGORY.SSL,
        severity:       SEVERITY.CRITICAL,
        title:          'SSL certificate has expired',
        detail:         `The SSL certificate for ${hostname} expired ${Math.abs(daysRemaining)} day(s) ago. All visitors will see a browser security warning blocking access to the site.`,
        evidence:       `Certificate expiry: ${cert.validTo}`,
        recommendation: 'Renew the SSL certificate immediately. Contact your hosting provider or certificate authority.',
        owasp:          'A02',
        wcag:           null
      }));
    } else if (daysRemaining <= 7) {
      findings.push(createFinding({
        id:             'ssl-cert-expiring-critical',
        runner:         RUNNER_NAME,
        category:       CATEGORY.SSL,
        severity:       SEVERITY.CRITICAL,
        title:          `SSL certificate expires in ${daysRemaining} day(s) — immediate action required`,
        detail:         `The SSL certificate for ${hostname} expires in ${daysRemaining} days. Once expired, all visitors will see a browser security error blocking access to the site.`,
        evidence:       `Certificate valid until: ${cert.validTo}`,
        recommendation: 'Renew the SSL certificate now. Do not wait — auto-renewal may have failed.',
        owasp:          'A02',
        wcag:           null
      }));
    } else if (daysRemaining <= 30) {
      findings.push(createFinding({
        id:             'ssl-cert-expiring-soon',
        runner:         RUNNER_NAME,
        category:       CATEGORY.SSL,
        severity:       SEVERITY.HIGH,
        title:          `SSL certificate expires in ${daysRemaining} days`,
        detail:         `The SSL certificate for ${hostname} expires in ${daysRemaining} days. Renewal should be scheduled within the next week to avoid expiry.`,
        evidence:       `Certificate valid until: ${cert.validTo}`,
        recommendation: 'Schedule SSL certificate renewal. Verify auto-renewal is configured and working.',
        owasp:          'A02',
        wcag:           null
      }));
    }
    // ── Hostname Coverage Check ───────────────────────────────────
    const isHostnameCovered = cert.subjectAltNames.some(san => matchesSan(san, hostname));
    if (!isHostnameCovered) {
      findings.push(createFinding({
        id:             'ssl-hostname-mismatch',
        runner:         RUNNER_NAME,
        category:       CATEGORY.SSL,
        severity:       SEVERITY.CRITICAL,
        title:          'SSL certificate does not cover this hostname',
        detail:         `The certificate's Subject Alternative Names do not include "${hostname}". Browsers will display a security error for all visitors.`,
        evidence:       `SANs on certificate: ${cert.subjectAltNames.join(', ')}`,
        recommendation: 'Obtain a new certificate that includes this hostname in the Subject Alternative Names list.',
        owasp:          'A02',
        wcag:           null
      }));
    }

    // ── Self-signed / Untrusted Check ─────────────────────────────
    if (cert.selfSigned) {
      findings.push(createFinding({
        id:             'ssl-self-signed',
        runner:         RUNNER_NAME,
        category:       CATEGORY.SSL,
        severity:       SEVERITY.HIGH,
        title:          'SSL certificate is self-signed and not trusted by browsers',
        detail:         'Self-signed certificates are not trusted by browsers. All visitors will see a security warning.',
        evidence:       `Issuer: ${cert.issuer} | Subject: ${cert.subject}`,
        recommendation: 'Replace with a certificate from a trusted Certificate Authority (e.g. Let\'s Encrypt, DigiCert).',
        owasp:          'A02',
        wcag:           null
      }));
    }

    // ── Store clean metrics ───────────────────────────────────────
    metrics.issuer          = cert.issuer;
    metrics.subject         = cert.subject;
    metrics.validFrom       = cert.validFrom;
    metrics.validTo         = cert.validTo;
    metrics.subjectAltNames = cert.subjectAltNames;
    metrics.selfSigned      = cert.selfSigned;
    metrics.fingerprint     = cert.fingerprint;

  } catch (err) {
    findings.push(createErrorFinding(RUNNER_NAME, err.message));
    logger.runnerError(RUNNER_NAME, err.message);
  }

  const result = createRunnerResult(RUNNER_NAME, url, findings, metrics);
  logger.runnerDone(RUNNER_NAME, findings.length);
  return result;
}

/**
 * Opens a TLS connection and extracts certificate details.
 * Uses rejectUnauthorized: false to inspect expired/self-signed certs.
 *
 * @param {string} hostname
 * @param {number} port
 * @returns {Promise<Object>} Certificate info
 */
function getCertificateInfoNative(hostname, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: TIMEOUT_MS },
      () => {
        try {
          const cert = socket.getPeerCertificate(true);
          socket.destroy();

          if (!cert || Object.keys(cert).length === 0) {
            return reject(new Error('Server returned no certificate'));
          }

          const subjectAltNames = parseSans(cert.subjectaltname ?? '');
          const issuerOrg       = cert.issuer?.O ?? cert.issuer?.CN ?? 'Unknown';
          const subjectCn       = cert.subject?.CN ?? 'Unknown';
          const selfSigned      = issuerOrg === subjectCn ||
                                  cert.issuer?.CN === cert.subject?.CN;

          resolve({
            subject:         subjectCn,
            issuer:          issuerOrg,
            validFrom:       cert.valid_from,
            validTo:         cert.valid_to,
            serialNumber:    cert.serialNumber ?? null,
            fingerprint:     cert.fingerprint  ?? null,
            subjectAltNames,
            selfSigned,
            source:          'tls'
          });
        } catch (err) {
          socket.destroy();
          reject(new Error(`Failed to parse certificate: ${err.message}`));
        }
      }
    );

    socket.on('error',   (err) => { socket.destroy(); reject(new Error(`TLS error: ${err.message}`)); });
    socket.on('timeout', ()    => { socket.destroy(); reject(new Error(`TLS connection timed out after ${TIMEOUT_MS}ms`)); });
  });
}

/**
 * Parses the subjectAltName string into an array of DNS names.
 * @param {string} sanString - e.g. "DNS:example.com, DNS:*.example.com"
 * @returns {string[]}
 */
function parseSans(sanString) {
  return sanString
    .split(',')
    .map(s => s.trim())
    .filter(s => s.toLowerCase().startsWith('dns:'))
    .map(s => s.slice(4).toLowerCase());
}

/**
 * Checks whether a SAN entry covers a given hostname.
 * Supports exact match and one-level wildcard (*.example.com).
 *
 * @param {string} san      - e.g. "*.partsconnexion.com" (should be lowercase)
 * @param {string} hostname - e.g. "www.partsconnexion.com"
 * @returns {boolean}
 */
function matchesSan(san, hostname) {
  const s = san.toLowerCase();
  const h = hostname.toLowerCase();
  if (s === h) return true;
  if (s.startsWith('*.')) {
    const wildDomain = s.slice(2);                       // "partsconnexion.com"
    const hostParts  = h.split('.');
    const wildParts  = wildDomain.split('.');
    // Wildcard matches exactly one label: www.example.com matches *.example.com
    // but sub.www.example.com does not
    return hostParts.length === wildParts.length + 1 &&
           h.endsWith(`.${wildDomain}`);
  }
  return false;
}


/**
 * Reads the certificate through Chromium (which honours the environment's proxy). Used when a raw
 * TLS socket cannot be opened, e.g. in sandboxes that only allow HTTP/HTTPS egress.
 */
async function getCertificateInfoViaBrowser(hostname) {
  const browser = await launchChromium();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let cdp = null;
    try { cdp = await context.newCDPSession(page); await cdp.send('Network.enable'); } catch { cdp = null; }
    const resp = await page.goto(`https://${hostname}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    const sec = resp ? await resp.securityDetails() : null;
    let x509 = null;
    try {
      const { tableNames } = await cdp.send('Network.getCertificate', { origin: `https://${hostname}` });
      for (const b64 of tableNames ?? []) {
        try { x509 = new X509Certificate(Buffer.from(b64, 'base64')); break; } catch { /* try next entry */ }
      }
    } catch { /* CDP certificate API unavailable: fall back to securityDetails() below */ }

    if (x509) {
      const issuerOrg = /(?:^|\n)O=([^\n]+)/.exec(x509.issuer)?.[1] ?? /(?:^|\n)CN=([^\n]+)/.exec(x509.issuer)?.[1] ?? 'Unknown';
      const subjectCn = /(?:^|\n)CN=([^\n]+)/.exec(x509.subject)?.[1] ?? 'Unknown';
      return {
        subject: subjectCn, issuer: issuerOrg, validFrom: x509.validFrom, validTo: x509.validTo,
        serialNumber: x509.serialNumber ?? null, fingerprint: x509.fingerprint ?? null,
        subjectAltNames: parseSans(x509.subjectAltName ?? ''), selfSigned: x509.issuer === x509.subject, source: 'browser'
      };
    }
    if (!sec) throw new Error('Browser exposed no certificate details');
    return {
      subject: sec.subjectName ?? 'Unknown', issuer: sec.issuer ?? 'Unknown',
      validFrom: new Date(sec.validFrom * 1000).toUTCString(), validTo: new Date(sec.validTo * 1000).toUTCString(),
      serialNumber: null, fingerprint: null, subjectAltNames: [], selfSigned: sec.issuer === sec.subjectName, source: 'browser'
    };
  } finally {
    await browser.close().catch(() => null);
  }
}

/**
 * True when outbound TLS may be re-signed by an environment proxy or a custom CA is trusted
 * (cloud sandbox: HTTPS_PROXY plus NODE_EXTRA_CA_CERTS / SSL_CERT_FILE). In that case a
 * non-public verdict cannot be told apart from interception, so the certificate is not reported.
 */
function isProxiedEnvironment() {
  return Boolean(proxyUrl() || process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE);
}

/**
 * Runs one handshake and reads the verdict from socket.authorized. rejectUnauthorized is false only
 * so the handshake completes and the certificate can be read; nothing is trusted on that basis.
 * @param {string} hostname
 * @param {number} port
 * @param {Object} [options] - extra tls.connect options, e.g. { ca } to choose the trust store
 * @returns {Promise<{ authorized: boolean, authorizationError: string|null, chainTop: string|null }>}
 */
function tlsVerify(hostname, port, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: TIMEOUT_MS, ...options },
      () => {
        let top = socket.getPeerCertificate(true);
        const seen = new Set();
        while (top?.issuerCertificate && top.issuerCertificate !== top && !seen.has(top.fingerprint256)) {
          seen.add(top.fingerprint256);
          top = top.issuerCertificate;
        }
        const chainTop = top?.subject ? `${top.subject.O ?? top.subject.CN ?? 'Unknown'} (${top.subject.CN ?? 'no CN'})` : null;
        const result = { authorized: socket.authorized === true, authorizationError: socket.authorizationError ?? null, chainTop };
        socket.destroy();
        resolve(result);
      }
    );
    socket.on('error',   (err) => { socket.destroy(); reject(err); });
    socket.on('timeout', ()    => { socket.destroy(); reject(new Error(`TLS connection timed out after ${TIMEOUT_MS}ms`)); });
  });
}

/**
 * Classifies whether the site's certificate chains to a public root, independently of how it is read.
 * - public:      verifies against Node's bundled public root store.
 * - intercepted: fails the public store but verifies only via an environment-supplied CA (interception).
 * - untrusted:   fails both stores (expired, self-signed, wrong host, private CA).
 * - unknown:     the handshake could not be completed.
 * @returns {Promise<{ verdict: string, reason: string|null, chainTop: string|null }>}
 */
async function checkTrust(hostname, port) {
  try {
    const pub = await tlsVerify(hostname, port, { ca: tls.rootCertificates });
    if (pub.authorized) return { verdict: 'public', reason: null, chainTop: pub.chainTop };
    const env = await tlsVerify(hostname, port);
    if (env.authorized) return { verdict: 'intercepted', reason: pub.authorizationError, chainTop: pub.chainTop };
    return { verdict: 'untrusted', reason: pub.authorizationError, chainTop: pub.chainTop };
  } catch (err) {
    return { verdict: 'unknown', reason: err.message, chainTop: null };
  }
}

/** Result for a proxied environment where the site's own certificate cannot be established. */
function indeterminateResult(url, hostname, trust) {
  const intercepted = trust.verdict === 'intercepted';
  const title = intercepted
    ? 'SSL check indeterminate due to cloud TLS interception'
    : 'SSL check indeterminate: certificate could not be verified through the cloud proxy';
  const detail = intercepted
    ? `Outbound TLS to ${hostname} is re-signed by the environment proxy. The certificate that can be read belongs to the proxy, not the site, so its expiry, issuer, and names are not reported. Verify the certificate from a network without TLS interception.`
    : `The certificate for ${hostname} could not be verified against public roots, and this environment routes TLS through a proxy, so the proxy cannot be ruled out. Its details are not reported.`;
  const findings = [createFinding({
    id:             'ssl-tls-interception-indeterminate',
    runner:         RUNNER_NAME,
    category:       CATEGORY.SSL,
    severity:       SEVERITY.INFO,
    title,
    detail,
    evidence:       `Trust verdict: ${trust.verdict}. Chain top observed (proxy, not the site): ${trust.chainTop ?? 'unavailable'}. Verification reason: ${trust.reason ?? 'none'}.`,
    recommendation: 'Run the SSL audit from a network without TLS interception to get the site\'s certificate details.',
    owasp:          null,
    wcag:           null
  })];
  return createRunnerResult(RUNNER_NAME, url, findings, { hostname, url, verdict: 'indeterminate', trust: trust.verdict });
}

/** SSL_MODE = auto (default: raw TLS, then browser) | native | browser */
async function getCertificateInfo(hostname, port) {
  const mode = (process.env.SSL_MODE ?? 'auto').toLowerCase();
  if (mode !== 'browser') {
    try {
      return await getCertificateInfoNative(hostname, port);
    } catch (err) {
      if (mode === 'native') throw err;
      logger.warn(`Raw TLS check failed (${err.message}); reading the certificate through the browser instead`);
    }
  }
  return getCertificateInfoViaBrowser(hostname);
}
