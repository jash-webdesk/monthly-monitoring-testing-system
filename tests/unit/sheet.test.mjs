import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSheet, parseDelimited, normalizeMonth } from '../../engine/sheet.js';
import { parseScores } from '../../engine/scores.js';

const H = ['Project', 'URL', 'Month', 'Page', 'Mobile Before', 'Mobile After', 'Desktop Before', 'Desktop After', 'Outputs', 'Dev Team Notes'].join('\t');

test('sheet: tab separated paste with fill-down creates one run per site', () => {
  const text = [
    H,
    ['Genpet', 'https://genpet.org', 'October 2026', 'Homepage', '68', '74', '79', '83', 'technical, client', ''].join('\t'),
    ['', '', '', 'About Us', '71', '77', '82', '87', '', ''].join('\t'),
    ['Parts', 'https://partsconnexion.com', '2026-10', 'Homepage', '36', '54', '88', '89', 'technical', ''].join('\t'),
    ['', 'https://audio-connexion.com', '', 'Homepage', '56', '56', '63', '71', '', ''].join('\t')
  ].join('\n');
  const { runs, problems } = parseSheet(text);
  assert.deepEqual(problems, []);
  assert.equal(runs.length, 3);
  assert.equal(runs[0].month, '2026-10');
  assert.deepEqual(runs[0].outputs, ['technical', 'client']);
  assert.equal(runs[0].scoresText, 'Homepage Mobile 68>74, Desktop 79>83; About Us Mobile 71>77, Desktop 82>87');
  assert.deepEqual(runs[1].outputs, ['technical']);
  assert.equal(runs[2].url, 'https://audio-connexion.com');
  assert.deepEqual(runs[2].outputs, ['technical'], 'outputs fill down from the previous row');
  assert.equal(parseScores(runs[0].scoresText).shared['about-us'].desktop.after, 87);
});

test('sheet: quoted multi-line dev notes survive and belong to their site', () => {
  const notes = 'A. Build Cache\n* App Server:\n   * Outcome: "cleared"';
  const quoted = '"' + notes.replace(/"/g, '""') + '"';
  const text = [H, ['Integrity', 'https://integrity-dashboard-bf73ab673f4c.herokuapp.com', '2026-10', '', '', '', '', '', 'client', quoted].join('\t')].join('\n');
  const { runs, problems } = parseSheet(text);
  assert.deepEqual(problems, []);
  assert.equal(runs[0].devNotes, notes);
  assert.equal(runs[0].pages.length, 0);
});

test('sheet: CSV with quotes works too', () => {
  const rows = parseDelimited('URL,Month,Page,Mobile Before,Mobile After\n"https://genpet.org","2026-10","Home, page",1,2');
  assert.equal(rows[1][2], 'Home, page');
});

test('sheet: problems are reported, not guessed', () => {
  const bad = [H, ['', 'https://genpet.org', 'Octember', 'Homepage', '68', '', '79', '183', '', ''].join('\t')].join('\n');
  const { problems } = parseSheet(bad);
  assert.ok(problems.some((p) => /not understood/.test(p)));
  assert.ok(problems.some((p) => /mobile needs both/.test(p)));
  assert.ok(problems.some((p) => /0 to 100/.test(p)));
  assert.ok(parseSheet('Foo\tBar\n1\t2').problems.some((p) => /URL/.test(p)));
});

test('sheet: month formats normalise', () => {
  assert.equal(normalizeMonth('October 2026'), '2026-10');
  assert.equal(normalizeMonth('Oct 2026'), '2026-10');
  assert.equal(normalizeMonth('10/2026'), '2026-10');
  assert.equal(normalizeMonth('2026-10'), '2026-10');
});
