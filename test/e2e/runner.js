/*
 * The runner CI's check job names, asked of the Playwright it pins. `npx playwright install
 * --with-deps chromium` downloads the Chromium build that Playwright names for the runner's Ubuntu
 * release, and fails where it names none: `ubuntu-latest` becomes Ubuntu 26.04 from 2026-10-19,
 * for which Playwright 1.56.1 has no build. So the job runs on a named release
 * (test/ci.test.js holds that), and this asks the pinned Playwright's own CLI, told that release's
 * platform, what it would download (--dry-run: nothing is fetched). The first step of
 * `npm run test:e2e`, which CI runs after its install step, with the pinned Playwright in place.
 *
 * Where the Playwright that resolves is not the one ci.yml pins this says so and passes, unless
 * CI is set: skipped there, it would read as passed.
 *
 *   npm run test:e2e, or node test/e2e/runner.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');

/** ci.yml's jobs, read from its block YAML (the conventions test holds every workflow to that
 *  shape): each job's name, its runs-on, and whether one of its `- run:` steps installs
 *  Playwright's browser (a comment that names the command is not a step). */
function jobs(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  if (start < 0) throw new Error('ci.yml has no jobs');
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const job = line.match(/^ {2}([\w-]+):\s*$/);
    if (job) { out.push({ name: job[1], runsOn: null, installsBrowser: false }); continue; }
    if (!out.length) continue;
    const runsOn = line.match(/^ {4}runs-on:\s*(\S+)\s*$/);
    if (runsOn) out[out.length - 1].runsOn = runsOn[1];
    if (/^\s*- run:.*\bplaywright install\b/.test(line)) out[out.length - 1].installsBrowser = true;
  }
  return out;
}

/** The Playwright version ci.yml installs (`playwright@X.Y.Z`). */
function pinned(text) {
  const m = text.match(/\bplaywright@(\d+\.\d+\.\d+)\b/);
  if (!m) throw new Error('ci.yml installs no exact Playwright version');
  return m[1];
}

/** The folder of the Playwright that resolves here (this checkout's, else the global one), or
 *  null. */
function playwrightDir() {
  try { return path.dirname(require.resolve('playwright/package.json', { paths: [root] })); } catch (e) { /* try global */ }
  try {
    const dir = path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright');
    return fs.existsSync(path.join(dir, 'package.json')) ? dir : null;
  } catch (e) {
    return null;
  }
}

/** What the Playwright in `dir` would download for Chromium on `platform` (`ubuntu24.04-x64`, as
 *  Playwright names one): the download address, or null when it has none. */
function chromiumDownload(dir, platform) {
  const browsers = fs.mkdtempSync(path.join(os.tmpdir(), 'srl-pw-'));
  try {
    const run = spawnSync(process.execPath, [path.join(dir, 'cli.js'), 'install', '--dry-run', 'chromium'], {
      encoding: 'utf8',
      env: { ...process.env, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: platform, PLAYWRIGHT_BROWSERS_PATH: browsers },
    });
    if (run.status !== 0) throw new Error('playwright install --dry-run chromium on ' + platform + ': ' + run.stderr);
    // one block per browser, separated by a blank line; Chromium's is headed "browser: chromium
    // version …" (1.56) or "… (playwright chromium v…)" (later releases)
    const block = run.stdout.split(/\n\s*\n/).find((b) => /^browser: chromium version |\(playwright chromium v\d+\)/m.test(b.split('\n')[0]));
    if (!block) throw new Error('the dry run names no Chromium on ' + platform + ':\n' + run.stdout);
    const url = block.match(/^\s*Download url:\s*(\S+)/m);
    return url ? url[1] : null;
  } finally {
    fs.rmSync(browsers, { recursive: true, force: true });
  }
}

module.exports = { jobs, pinned, chromiumDownload };

if (require.main === module) {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const pin = pinned(ci);
  const dir = playwrightDir();
  const version = dir ? JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version : null;
  if (version !== pin) {
    const note = 'runner: Playwright ' + pin + ' (what ci.yml installs) is not the one that resolves here (' + (version || 'none') + ')';
    if (process.env.CI) {
      console.error(note + '. CI installs it before this runs, so this is a failure.');
      process.exit(1);
    }
    console.log(note + '. SKIPPED: the runner was not asked of the pinned Playwright; CI asks it.');
    process.exit(0);
  }
  let failures = 0;
  const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failures++; };
  // The question is the right one: told a platform it supports, the CLI gives an address, and
  // told 26.04 (what ubuntu-latest becomes), 1.56.1 gives none.
  check(/^https:\/\/\S+\.zip$/.test(chromiumDownload(dir, 'ubuntu24.04-x64') || ''), 'Playwright ' + pin + ' names a Chromium build for ubuntu24.04-x64');
  if (pin === '1.56.1') check(chromiumDownload(dir, 'ubuntu26.04-x64') === null, 'and none for ubuntu26.04-x64, what ubuntu-latest becomes');
  const installing = jobs(ci).filter((j) => j.installsBrowser);
  check(installing.length > 0, 'ci.yml has a job that installs the browser (' + installing.map((j) => j.name).join(', ') + ')');
  for (const job of installing) {
    const release = String(job.runsOn).match(/^ubuntu-(\d{2}\.\d{2})$/);
    check(!!release, 'the ' + job.name + ' job runs on a named Ubuntu release (' + job.runsOn + ')');
    if (release) check(!!chromiumDownload(dir, 'ubuntu' + release[1] + '-x64'), 'Playwright ' + pin + ' has a Chromium build for ' + job.runsOn + ', where the ' + job.name + ' job installs it');
  }
  if (failures) {
    console.error('runner: ' + failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('runner OK: Playwright ' + pin + ' on ' + installing.map((j) => j.runsOn).join(', '));
}
