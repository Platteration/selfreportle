/*
 * The browser suites run on GitHub's runner after `npx playwright install --with-deps chromium`,
 * which downloads the Chromium build the pinned Playwright names for the runner's Ubuntu release
 * and fails where it names none. `ubuntu-latest` is a label that moves: from 2026-10-19 it is
 * Ubuntu 26.04, for which Playwright 1.56.1 has no build, so CI would have gone red with nothing in
 * the repository changed. So every job that installs the browser runs on a named release. This
 * reads ci.yml; test/e2e/runner.js, the first step of `npm run test:e2e` (which runs after CI's
 * install), asks the pinned Playwright itself whether it has a Chromium build for that release.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runner = require('./e2e/runner.js');

const root = path.join(__dirname, '..');
const CI = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

test("every job that installs Playwright's browser runs on a named Ubuntu release", () => {
  const jobs = runner.jobs(CI);
  assert.deepEqual(jobs.map((j) => j.name), ['check'], 'ci.yml has its check job, and this read it');
  const installing = jobs.filter((j) => j.installsBrowser);
  assert.deepEqual(installing.map((j) => j.name), ['check'], 'the check job installs the browser');
  for (const job of installing) {
    assert.match(String(job.runsOn), /^ubuntu-\d{2}\.\d{2}$/, `the ${job.name} job runs on ${job.runsOn}; a job that installs the browser runs on a named Ubuntu release (ubuntu-24.04), never a label that moves`);
  }
});

test('Playwright is pinned once, to an exact version, and ci.yml says why its runner is named for that version', () => {
  const pin = runner.pinned(CI);
  assert.match(pin, /^\d+\.\d+\.\d+$/);
  assert.equal([...CI.matchAll(/\bplaywright@/g)].length, 1, 'one install of Playwright');
  // Raising Playwright is a reason to read the runner again: the comment names the version.
  assert.match(CI, new RegExp(`Playwright ${pin.replace(/\./g, '\\.')} has no Chromium build for 26\\.04`), 'ci.yml says why its runner is named, for the Playwright it pins');
});

test('the job reader sees what a moving label or a missing install would look like', () => {
  // The checks above are only as good as the reader: it must see ubuntu-latest, and a job that
  // installs nothing.
  const latest = CI.replace(/^ {4}runs-on: \S+$/m, '    runs-on: ubuntu-latest');
  assert.equal(runner.jobs(latest)[0].runsOn, 'ubuntu-latest');
  const none = CI.replace(/^ {6}- run: npx playwright install[^\n]*\n/m, '');
  assert.notEqual(none, CI, 'the install step was found to take out');
  assert.equal(runner.jobs(none)[0].installsBrowser, false);
});
