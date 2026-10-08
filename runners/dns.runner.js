import dns from '../lib/resolver.js';
import { createFinding, createErrorFinding, createRunnerResult, SEVERITY, CATEGORY } from '../lib/result.js';
import { logger } from '../lib/logger.js';

const RUNNER_NAME = 'dns';

// Common DKIM selectors to probe
const DKIM_SELECTORS = ['default', 'google', 'mail', 'k1', 'selector1', 'selector2', 'dkim', 's1', 's2'];

/**
 * Runs the DNS snapshot runner for a hostname.
 * Captures A, AAAA, CNAME, MX, NS, TXT records.
 * Validates SPF, DKIM, and DMARC configuration.
 *
 * @param {string} hostname - Domain to audit e.g. "partsconnexion.com"
 * @returns {Promise<Object>} Runner result envelope
 */
export async function runDns(hostname) {
  logger.runnerStart(RUNNER_NAME);

  if (!hostname || typeof hostname !== 'string') {
    const result = createRunnerResult(RUNNER_NAME, hostname, [
      createErrorFinding(RUNNER_NAME, 'Invalid hostname provided')
    ]);
    logger.runnerDone(RUNNER_NAME, 1);
    return result;
  }

  const findings = [];
  const metrics  = { hostname, capturedAt: new Date().toISOString() };

  try {
    // ── A Records ────────────────────────────────────────────────
    try {
      metrics.aRecords = await dns.resolve4(hostname);
      logger.debug(`DNS A records: ${metrics.aRecords.join(', ')}`);
    } catch {
      metrics.aRecords = [];
      findings.push(createFinding({
        id:             'dns-no-a-record',
        runner:         RUNNER_NAME,
        category:       CATEGORY.DNS,
        severity:       SEVERITY.HIGH,
        title:          'No A record found for domain',
        detail:         `DNS lookup for ${hostname} returned no IPv4 A records. The site may be unreachable.`,
        evidence:       `dns.resolve4("${hostname}") returned no results`,
        recommendation: 'Verify DNS A record configuration with your DNS provider.',
        owasp:          null,
        wcag:           null
      }));
    }

    // ── AAAA Records (IPv6) ───────────────────────────────────────
    try {
      metrics.aaaaRecords = await dns.resolve6(hostname);
    } catch {
      metrics.aaaaRecords = []; // IPv6 absence is not a finding
    }

    // ── CNAME Records ─────────────────────────────────────────────
    try {
      metrics.cnameRecords = await dns.resolveCname(hostname);
    } catch {
      metrics.cnameRecords = [];
    }

    // ── MX Records ────────────────────────────────────────────────
    try {
      metrics.mxRecords = await dns.resolveMx(hostname);
    } catch {
      metrics.mxRecords = [];
      findings.push(createFinding({
        id:             'dns-no-mx-record',
        runner:         RUNNER_NAME,
        category:       CATEGORY.DNS,
        severity:       SEVERITY.MEDIUM,
        title:          'No MX records found',
        detail:         `No mail exchange (MX) records found for ${hostname}. Email delivery to this domain may not function.`,
        evidence:       `dns.resolveMx("${hostname}") returned no results`,
        recommendation: 'Configure MX records with your email provider if email is required for this domain.',
        owasp:          null,
        wcag:           null
      }));
    }

    // ── NS Records ────────────────────────────────────────────────
    try {
      metrics.nsRecords = await dns.resolveNs(hostname);
    } catch {
      metrics.nsRecords = [];
    }

    // ── TXT Records ───────────────────────────────────────────────
    try {
      const raw = await dns.resolveTxt(hostname);
      metrics.txtRecords = raw.map(r => r.join(''));
    } catch {
      metrics.txtRecords = [];
    }

    // ── SPF Check ─────────────────────────────────────────────────
    const spf = metrics.txtRecords.find(r => r.startsWith('v=spf1'));
    if (!spf) {
      findings.push(createFinding({
        id:             'dns-no-spf-record',
        runner:         RUNNER_NAME,
        category:       CATEGORY.SECURITY,
        severity:       SEVERITY.HIGH,
        title:          'No SPF record found',
        detail:         'SPF (Sender Policy Framework) prevents email spoofing by specifying which servers can send email for this domain. Without it, anyone can forge emails from this domain.',
        evidence:       `No TXT record starting with "v=spf1" found for ${hostname}`,
        recommendation: 'Add an SPF TXT record: "v=spf1 include:youremailprovider.com ~all"',
        owasp:          'A05',
        wcag:           null
      }));
    } else {
      metrics.spf = spf;
      if (spf.includes('+all')) {
        findings.push(createFinding({
          id:             'dns-spf-too-permissive',
          runner:         RUNNER_NAME,
          category:       CATEGORY.SECURITY,
          severity:       SEVERITY.HIGH,
          title:          'SPF record uses +all — any server can send email as this domain',
          detail:         'The "+all" qualifier means any mail server on the internet is authorised to send email from this domain. This provides no anti-spoofing protection.',
          evidence:       spf,
          recommendation: 'Change "+all" to "~all" (soft fail) or "-all" (hard fail).',
          owasp:          'A05',
          wcag:           null
        }));
      }
    }

    // ── DMARC Check ───────────────────────────────────────────────
    let dmarc = null;
    try {
      const raw = await dns.resolveTxt(`_dmarc.${hostname}`);
      dmarc = raw.flat().join('');
      metrics.dmarc = dmarc;
    } catch {
      metrics.dmarc = null;
    }

    if (!dmarc) {
      findings.push(createFinding({
        id:             'dns-no-dmarc-record',
        runner:         RUNNER_NAME,
        category:       CATEGORY.SECURITY,
        severity:       SEVERITY.HIGH,
        title:          'No DMARC record found',
        detail:         'DMARC tells receiving mail servers what to do with emails that fail SPF or DKIM checks. Without it, spoofed emails from this domain may be delivered to recipients.',
        evidence:       `No TXT record found at _dmarc.${hostname}`,
        recommendation: 'Add a DMARC record: v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com',
        owasp:          'A05',
        wcag:           null
      }));
    } else {
      const policyMatch = dmarc.match(/p=(none|quarantine|reject)/);
      if (policyMatch?.[1] === 'none') {
        findings.push(createFinding({
          id:             'dns-dmarc-policy-none',
          runner:         RUNNER_NAME,
          category:       CATEGORY.SECURITY,
          severity:       SEVERITY.MEDIUM,
          title:          'DMARC policy is "none" — monitoring only, no enforcement',
          detail:         'A DMARC policy of "none" means emails that fail authentication are still delivered. This provides reporting data but offers no protection against spoofing.',
          evidence:       dmarc,
          recommendation: 'Upgrade to p=quarantine (routes to spam) or p=reject (blocks delivery) once legitimate email flows are verified.',
          owasp:          'A05',
          wcag:           null
        }));
      }

      if (!dmarc.includes('rua=')) {
        findings.push(createFinding({
          id:             'dns-dmarc-no-reporting',
          runner:         RUNNER_NAME,
          category:       CATEGORY.DNS,
          severity:       SEVERITY.LOW,
          title:          'DMARC record has no aggregate reporting address (rua)',
          detail:         'Without a reporting address, you will not receive DMARC aggregate reports showing who is sending email on behalf of your domain.',
          evidence:       dmarc,
          recommendation: 'Add rua=mailto:dmarc@yourdomain.com to your DMARC record.',
          owasp:          null,
          wcag:           null
        }));
      }
    }

    // ── DKIM Check (probe common selectors) ───────────────────────
    let dkimFound = false;
    for (const selector of DKIM_SELECTORS) {
      try {
        const raw = await dns.resolveTxt(`${selector}._domainkey.${hostname}`);
        if (raw.length > 0) {
          dkimFound = true;
          metrics.dkim = { selector, record: raw.flat().join('') };
          logger.debug(`DKIM found at selector: ${selector}`);
          break;
        }
      } catch {
        // Selector not found — try next
      }
    }

    if (!dkimFound) {
      findings.push(createFinding({
        id:             'dns-no-dkim-record',
        runner:         RUNNER_NAME,
        category:       CATEGORY.SECURITY,
        severity:       SEVERITY.MEDIUM,
        title:          'No DKIM record found',
        detail:         'DKIM adds a cryptographic signature to outgoing emails, allowing recipients to verify they were sent by an authorised server and have not been tampered with.',
        evidence:       `Checked selectors: ${DKIM_SELECTORS.join(', ')}. None found at {selector}._domainkey.${hostname}`,
        recommendation: 'Configure DKIM through your email provider and publish the public key as a TXT record at the appropriate selector.',
        owasp:          'A05',
        wcag:           null
      }));
    }

    // ── Full snapshot for month-over-month diff ───────────────────
    metrics.snapshot = {
      hostname,
      aRecords:    metrics.aRecords,
      aaaaRecords: metrics.aaaaRecords,
      cnameRecords: metrics.cnameRecords,
      mxRecords:   metrics.mxRecords,
      nsRecords:   metrics.nsRecords,
      txtRecords:  metrics.txtRecords,
      capturedAt:  new Date().toISOString()
    };

  } catch (err) {
    findings.push(createErrorFinding(RUNNER_NAME, err.message));
    logger.runnerError(RUNNER_NAME, err.message);
  }

  const result = createRunnerResult(RUNNER_NAME, hostname, findings, metrics);
  logger.runnerDone(RUNNER_NAME, findings.length);
  return result;
}
