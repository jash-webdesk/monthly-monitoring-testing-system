import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeDns, DNS_NOT_AVAILABLE } from '../../report/dns-view.js';

const FORBIDDEN_FALLBACKS = [/Monroe/i, /Network Solutions/i, /Cloudflare \(/i, /\?\?\s*24\b/, /: 24;/];

test('dns report: no DNS result gives "Not available" everywhere, never a provider or default count', () => {
  const v = describeDns(undefined);
  assert.equal(v.nsText, DNS_NOT_AVAILABLE);
  assert.equal(v.mxText, DNS_NOT_AVAILABLE);
  assert.equal(v.aText, DNS_NOT_AVAILABLE);
  assert.equal(v.spfText, DNS_NOT_AVAILABLE);
  assert.equal(v.recordCount, null);
  assert.equal(v.spfPresent, null);
  assert.equal(v.dmarcPresent, null);
  assert.equal(v.dkimPresent, null);
});

test('dns report: empty NS and MX lists are not replaced by a provider name', () => {
  const v = describeDns({ metrics: { nsRecords: [], mxRecords: [], aRecords: ['1.2.3.4'], txtRecords: [], spf: false } });
  assert.equal(v.nsText, DNS_NOT_AVAILABLE);
  assert.equal(v.mxText, DNS_NOT_AVAILABLE);
  assert.equal(v.aText, 'Resolving correctly');
  assert.equal(v.spfText, 'Not found');
  assert.equal(v.spfPresent, false);
  assert.equal(v.recordCount, 1);
});

test('dns report: real records are reported as returned', () => {
  const v = describeDns({
    metrics: {
      aRecords: ['1.2.3.4'], mxRecords: [{ exchange: 'mx1.example.com', priority: 10 }],
      nsRecords: ['ns1.example.com', 'ns2.example.com'], txtRecords: ['v=spf1 -all'],
      spf: true, dmarc: true, dkim: false
    }
  });
  assert.equal(v.nsText, 'ns1.example.com, ns2.example.com');
  assert.equal(v.mxText, 'mx1.example.com (Priority 10)');
  assert.equal(v.spfText, 'In place');
  assert.equal(v.dkimPresent, false);
  assert.equal(v.dmarcPresent, true);
  assert.equal(v.recordCount, 5);
});

test('dns report: the generators contain no hard-coded provider or DNS count fallback', () => {
  for (const file of ['../../generate_ppt_report.js', '../../report/generator.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const pattern of FORBIDDEN_FALLBACKS) assert.doesNotMatch(src, pattern, `${file} still contains ${pattern}`);
  }
});
