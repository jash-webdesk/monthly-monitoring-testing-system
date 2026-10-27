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

test('config: every project site has a hostname and name, and project files carry no hand-set performance scores', () => {
  for (const s of loadSitesConfig().sites) {
    assert.ok(s.hostname && s.name, `a site in ${s.project} is missing hostname or name`);
    const now = getSiteConfig(s.hostname);
    const perf = [now.scores?.desktop?.before?.performance, now.scores?.desktop?.after?.performance, now.scores?.mobile?.before?.performance, now.scores?.mobile?.after?.performance];
    assert.ok(perf.every((v) => v === undefined), `${s.hostname}: performance scores come from the monthly prompt, not the project file`);
  }
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

test('scores: prompt-builder text with per-site lines gives each site its own scores', async () => {
  const { siteAliases } = await import('../../engine/scores.js');
  const parts = loadProjects().find((p) => p.id === 'parts-audio-connexion');
  const aliases = siteAliases(parts.sites, parts.reportMeta.clientDisplayNames);
  const text = 'PartsConnexion: Homepage Mobile Before 36 -> After 54, Desktop Before 88 -> After 89\nAudioConnexion: Homepage Mobile Before 56 -> After 56, Desktop Before 63 -> After 71; Shop Desktop Before 50 -> After 55';
  const p = parseScores(text, { aliases });
  assert.deepEqual(Object.keys(p.byHost).sort(), ['audio-connexion.com', 'partsconnexion.com']);
  assert.deepEqual(p.byHost['partsconnexion.com'].homepage.mobile, { before: 36, after: 54 });
  assert.deepEqual(p.byHost['audio-connexion.com'].homepage.desktop, { before: 63, after: 71 });
  assert.deepEqual(Object.keys(p.byHost['audio-connexion.com']), ['homepage', 'shop']);
  assert.equal(p.shared, null);
});

test('scores: "Before 68 -> After 74" wording parses without a site label', () => {
  const p = parseScores('Homepage Mobile Before 68 -> After 74, Desktop Before 79 -> After 83');
  assert.deepEqual(p.shared.homepage.desktop, { before: 79, after: 83 });
});

test('config: fixed category scores sit under the prompt scores and only apply to the site that has them', async () => {
  const { getSiteConfig: get, setRuntimeOverrides: set } = await import('../../lib/config.js');
  const parts = get('partsconnexion.com');
  assert.equal(parts.scores.desktop.after.accessibility, 87);
  assert.equal(parts.scores.mobile.after.accessibility, 91);
  assert.equal(parts.scores.mobile.after.bestPractices, 96);
  assert.deepEqual(parts.agenticBrowsing, { result: 'Pass', passed: 2, total: 2 });
  set('partsconnexion.com', { scores: { desktop: { before: { performance: 88 }, after: { performance: 89 } } } });
  const merged = get('partsconnexion.com').scores;
  assert.equal(merged.desktop.after.performance, 89);
  assert.equal(merged.desktop.after.accessibility, 87, 'fixed value survives the per-run scores');
  assert.equal(get('genpet.org').scores?.desktop?.after?.accessibility, undefined, 'no other site inherits them');
  assert.equal(get('audio-connexion.com').scores?.desktop?.after?.accessibility, undefined);
  assert.equal(get('audio-connexion.com').agenticBrowsing, undefined);
});
