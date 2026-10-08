import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSslCertificate } from '../../report/generator.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const PUBLIC_CERT = {
  verdict: undefined,
  trust: 'public',
  daysUntilExpiry: 40,
  certificate: { validTo: 'Nov 17 12:00:00 2026 GMT', issuer: 'Let\'s Encrypt', subjectAltNames: ['example.com'] }
};

test('ssl report: public result with certificate metrics reports the real expiry', () => {
  const v = describeSslCertificate({ metrics: PUBLIC_CERT }, NOW);
  assert.equal(v.determined, true);
  assert.equal(v.days, 40);
  assert.equal(v.issuer, 'Let\'s Encrypt');
  assert.match(v.expiryText, /2026/);
  assert.equal(v.daysBadge, 'HEALTHY');
  assert.equal(v.issuerBadge, 'VALID');
});

test('ssl report: legacy result without a trust field keeps its real values', () => {
  const v = describeSslCertificate({ metrics: { daysUntilExpiry: 12, certificate: { validTo: 'Oct 20 12:00:00 2026 GMT', issuer: 'DigiCert' } } }, NOW);
  assert.equal(v.determined, true);
  assert.equal(v.days, 12);
  assert.equal(v.daysBadge, 'MONITOR');
});

test('ssl report: missing certificate metrics never fall back to 30 days', () => {
  const v = describeSslCertificate({ metrics: { trust: 'public' }, findings: [] }, NOW);
  assert.equal(v.determined, false);
  assert.equal(v.days, null);
  assert.equal(v.daysText, 'Could not be determined');
  assert.equal(v.expiryText, 'Could not be determined');
  assert.equal(v.expiryBadge, 'NOT DETERMINED');
  assert.equal(v.daysBadge, 'NOT DETERMINED');
});

test('ssl report: missing SSL result is reported as not checked, with no expiry', () => {
  const v = describeSslCertificate(undefined, NOW);
  assert.equal(v.determined, false);
  assert.equal(v.days, null);
  assert.equal(v.issuerBadge, 'NOT CHECKED');
  assert.equal(v.reason, 'No SSL check was run for this site.');
});

for (const trust of ['intercepted', 'unknown']) {
  test(`ssl report: ${trust} verdict is not determined even if certificate metrics are present`, () => {
    const v = describeSslCertificate({ metrics: { trust, certificate: { validTo: 'Nov 17 12:00:00 2026 GMT', issuer: 'Anthropic' }, daysUntilExpiry: 40 } }, NOW);
    assert.equal(v.determined, false);
    assert.equal(v.days, null);
    assert.equal(v.issuer, null);
    assert.equal(v.expiryText, 'Could not be determined');
    assert.equal(v.issuerBadge, 'NOT DETERMINED');
    assert.ok(v.reason);
  });
}

test('ssl report: indeterminate result (intercepted, no metrics) reports expiry as not determined', () => {
  const v = describeSslCertificate({ metrics: { verdict: 'indeterminate', trust: 'intercepted' }, findings: [{ id: 'ssl-tls-interception-indeterminate' }] }, NOW);
  assert.equal(v.determined, false);
  assert.equal(v.days, null);
  assert.equal(v.expiryText, 'Could not be determined');
  assert.match(v.reason, /proxy/);
});

test('ssl report: indeterminate overrides an untrusted trust verdict', () => {
  const v = describeSslCertificate({ metrics: { verdict: 'indeterminate', trust: 'untrusted', certificate: { validTo: 'Nov 17 12:00:00 2026 GMT' } } }, NOW);
  assert.equal(v.determined, false);
  assert.equal(v.days, null);
});

test('ssl report: untrusted result with certificate metrics keeps the real values (existing behaviour)', () => {
  const v = describeSslCertificate({ metrics: { trust: 'untrusted', daysUntilExpiry: 3, certificate: { validTo: 'Oct 11 12:00:00 2026 GMT', issuer: 'Self' } } }, NOW);
  assert.equal(v.determined, true);
  assert.equal(v.days, 3);
  assert.equal(v.daysBadge, 'URGENT');
});

test('ssl report: days are computed from validTo when the runner did not store them', () => {
  const v = describeSslCertificate({ metrics: { trust: 'public', certificate: { validTo: 'Nov 17 12:00:00 2026 GMT' } } }, NOW);
  assert.equal(v.days, 40);
});
