import test from 'node:test';
import assert from 'node:assert/strict';
import { analysePage } from '../../runners/storefront.runner.js';
import { readFileSync } from 'node:fs';

test('analysePage reads title, description, canonical, sharing tags, headings and structured data', () => {
  const html = `<html><head><title> Swaddle </title>
    <meta name="description" content="Soft cotton">
    <link rel="canonical" href="https://example.com/swaddle/">
    <meta property="og:title" content="Swaddle"><meta property="og:image" content="https://example.com/a.jpg">
    <script type="application/ld+json">{"@type":"Product"}</script></head>
    <body><h1>One</h1><h2>A</h2><h2>B</h2></body></html>`;
  const a = analysePage(html);
  assert.equal(a.title, 'Swaddle');
  assert.equal(a.description, 'Soft cotton');
  assert.equal(a.canonical, 'https://example.com/swaddle/');
  assert.equal(a.ogTitle, 'Swaddle');
  assert.equal(a.h1, 1);
  assert.equal(a.h2, 2);
  assert.deepEqual(a.structured, ['Product']);
});

test('analysePage reports missing pieces as empty, not invented', () => {
  const a = analysePage('<html><body><p>hi</p></body></html>');
  assert.equal(a.title, '');
  assert.equal(a.description, '');
  assert.equal(a.canonical, '');
  assert.equal(a.h1, 0);
  assert.deepEqual(a.structured, []);
});

test('project config: our-green-house has a storefront block and the ogh-deck report', () => {
  const p = JSON.parse(readFileSync(new URL('../../projects/our-green-house.json', import.meta.url), 'utf8'));
  assert.equal(p.reports.client, 'ogh-deck');
  assert.ok(p.sites[0].storefront.sampleProduct.startsWith('/'));
  assert.equal(p.inputs.performanceScores, 'not-applicable');
});
