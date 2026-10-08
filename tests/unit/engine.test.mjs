import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScores, scoresForHost, toLegacyScores, flattenScores } from '../../engine/scores.js';
import { identifyProject } from '../../engine/identify.js';
import { loadProjects, loadSitesConfig, getSiteConfig, setRuntimeOverrides } from '../../lib/config.js';
import { normalizeOutputs } from '../../engine/reports.js';
import { CATEGORIES } from '../../audits/index.js';

const PROMPT = 'Homepage Mobile 68>74, Desktop 79>83; About Us Mobile 71>77, Desktop 82>87';

test('scores: compact text parses into canonical pages with any page count', () => {
  const p = parseScores(PROMPT);
  const pages = scoresForHost(p, 'genpet.org');
  assert.deepEqual(Object.keys(pages), ['homepage', 'about-us']);
  assert.deepEqual(pages.homepage.mobile, { before: 68, after: 74 });
  assert.deepEqual(pages['about-us'].desktop, { before: 82, after: 87 });
  assert.equal(flattenScores(pages).length, 4);
});

test('scores: JSON arrays, per-host wrapper and a single viewport are accepted', () => {
  const p = parseScores(JSON.stringify({ 'audio-connexion.com': { Homepage: { desktop: [63, 71] } }, 'partsconnexion.com': { Homepage: { mobile: { before: 36, after: 54 } }, Shop: { desktop: [50, 55] } } }));
  assert.deepEqual(Object.keys(scoresForHost(p, 'partsconnexion.com')), ['homepage', 'shop']);
  assert.equal(scoresForHost(p, 'audio-connexion.com').homepage.desktop.after, 71);
  assert.equal(scoresForHost(p, 'www.audio-connexion.com').homepage.desktop.before, 63);
  assert.equal(scoresForHost(p, 'genpet.org'), null);
});

test('scores: invalid values are rejected', () => {
  assert.throws(() => parseScores('{"Homepage":{"mobile":[68,140]}}'), /Invalid score/);
  assert.throws(() => parseScores('{"Homepage":{}}'), /neither mobile nor desktop/);
});

test('scores: legacy adapter maps homepage to the headline cards and About Us to aboutUs', () => {
  const legacy = toLegacyScores(scoresForHost(parseScores(PROMPT), 'genpet.org'));
  assert.equal(legacy.desktop.before.performance, 79);
  assert.equal(legacy.mobile.after.performance, 74);
  assert.deepEqual(legacy.aboutUs.mobile, { before: 71, after: 77 });
  assert.equal(legacy.desktop.after.accessibility, undefined);
});

test('identify: each project claims its domains, www is ignored, unknown hosts are rejected', () => {
  assert.equal(identifyProject('https://www.genpet.org/').project.id, 'genpet');
  assert.equal(identifyProject('partsconnexion.com').project.id, 'parts-audio-connexion');
  assert.equal(identifyProject('https://audio-connexion.com/').site.hostname, 'audio-connexion.com');
  assert.equal(identifyProject('https://integrity-dashboard-bf73ab673f4c.herokuapp.com/login').project.id, 'integrity-reforestation');
  assert.throws(() => identifyProject('https://not-a-client.example/'), /No project configuration/);
});

test('projects: Integrity does not use performance scores; scored projects require them', () => {
  const by = Object.fromEntries(loadProjects().map((p) => [p.id, p]));
  assert.equal(by['integrity-reforestation'].inputs.performanceScores, 'not-applicable');
  for (const id of ['genpet', 'parts-audio-connexion']) assert.equal(by[id].inputs.performanceScores, 'required');
  for (const p of Object.values(by)) for (const c of Object.keys(p.audits)) assert.ok(CATEGORIES.includes(c), `${p.id} configures unknown audit ${c}`);
});

test('config: every site from the legacy config/sites.json is preserved (scores aside)', () => {
  const legacy = JSON.parse(readFileSync(new URL('../../config/sites.json', import.meta.url), 'utf8')).sites;
  for (const old of legacy) {
    const now = getSiteConfig(old.hostname);
    const { scores, ...rest } = old;
    for (const [k, v] of Object.entries(rest)) assert.deepEqual(now[k], v, `${old.hostname}.${k} changed`);
    assert.equal(now.scores, undefined, 'project files must not carry hand-set scores');
  }
  assert.ok(loadSitesConfig().sites.length >= legacy.length);
});

test('config: runtime score overrides reach the generators through getSiteConfig', () => {
  setRuntimeOverrides('genpet.org', { scores: { desktop: { before: { performance: 1 }, after: { performance: 2 } } } });
  assert.equal(getSiteConfig('genpet.org').scores.desktop.after.performance, 2);
});

test('outputs: aliases normalise and unknown types fail', () => {
  assert.deepEqual(normalizeOutputs(['Technical Report', 'Client Report']).sort(), ['client', 'technical']);
  assert.deepEqual(normalizeOutputs(['Client PPTX']), ['client']);
  assert.throws(() => normalizeOutputs(['spreadsheet']), /Unknown output type/);
});
