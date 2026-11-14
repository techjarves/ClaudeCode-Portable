import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest } from '../lib/runtime.mjs';
import {
  availablePlaywrightUpdate,
  ensurePlaywright,
  installPlaywright,
  playwrightBrowsersPresent,
  playwrightPackageVersion,
  playwrightStatus,
  savePlaywrightPin,
} from '../lib/playwright.mjs';

const temp = mkdtempSync(join(tmpdir(), 'portable-playwright-'));
test.after(() => rmSync(temp, { recursive: true, force: true }));

const PIN = manifest.playwright;
assert.equal(typeof PIN, 'string', 'the manifest must pin a Playwright version');

// A fake filesystem state: the runner reports the files it would have created.
function workspace(name) {
  const directory = join(temp, name, 'playwright');
  const browsersDirectory = join(temp, name, 'playwright-browsers');
  const cli = join(directory, 'node_modules', 'playwright', 'cli.js');
  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args.includes('install') && args.some(arg => String(arg).startsWith('playwright@'))) {
      const version = args.find(arg => String(arg).startsWith('playwright@')).split('@')[1];
      mkdirSync(join(directory, 'node_modules', 'playwright'), { recursive: true });
      writeFileSync(join(directory, 'node_modules', 'playwright', 'package.json'), JSON.stringify({ version }));
      writeFileSync(cli, '// playwright cli');
    }
    if (args[1] === 'install' || args.includes('--only-shell')) {
      mkdirSync(join(browsersDirectory, 'chromium_headless_shell-1255'), { recursive: true });
    }
    return '';
  };
  return { directory, browsersDirectory, cli, calls, runner };
}

test('status reports a missing installation and the pinned version', () => {
  const space = workspace('missing');
  const status = playwrightStatus(space);
  assert.equal(status.pinned, PIN);
  assert.equal(status.installed, null);
  assert.equal(status.browsers, false);
  assert.equal(status.ready, false);
  assert.equal(status.executable, null);
  assert.equal(playwrightPackageVersion(space.directory), null);
  assert.equal(playwrightBrowsersPresent(space.browsersDirectory), false);
});

test('installing pins the package and fetches only the headless shell', async () => {
  const space = workspace('install');
  const output = [];
  const status = await installPlaywright({ ...space, onOutput: text => output.push(text) });
  assert.equal(status.ready, true);
  assert.equal(status.installed, PIN);

  const npmCall = space.calls[0];
  assert.ok(npmCall.args.includes(`playwright@${PIN}`), 'the pinned version is installed');
  assert.ok(npmCall.args.includes('--prefix'));
  assert.ok(npmCall.args.includes('--no-bin-links'), 'USB drives cannot use npm bin links');
  // The npm postinstall must not download browsers on its own.
  assert.equal(npmCall.options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
  assert.equal(npmCall.options.env.PLAYWRIGHT_BROWSERS_PATH, space.browsersDirectory);

  const browserCall = space.calls[1];
  assert.ok(browserCall.args.includes('--only-shell'));
  assert.ok(browserCall.args.includes('chromium'));
  assert.ok(browserCall.args.includes('--no-remove'), 'browsers from another machine must survive');
  assert.equal(browserCall.options.env.PLAYWRIGHT_BROWSERS_PATH, space.browsersDirectory);
  assert.match(output.join(''), /Installing the headless Chromium build/);
});

test('an installed, pinned package skips the npm step but still verifies browsers', async () => {
  const space = workspace('repeat');
  await installPlaywright({ ...space });
  space.calls.length = 0;
  await installPlaywright({ ...space });
  assert.equal(space.calls.length, 1, 'only the idempotent browser check runs');
  assert.ok(space.calls[0].args.includes('--only-shell'));
  // force reinstalls the package.
  space.calls.length = 0;
  await installPlaywright({ ...space, force: true });
  assert.equal(space.calls.length, 2);
});

test('ensurePlaywright installs only when something is missing', async () => {
  const space = workspace('ensure');
  const first = await ensurePlaywright({ ...space, env: {} });
  assert.equal(first.installed, true);
  const callsAfterFirst = space.calls.length;
  const second = await ensurePlaywright({ ...space, env: {} });
  assert.equal(second.skipped, 'current');
  assert.equal(space.calls.length, callsAfterFirst, 'nothing runs when it is ready');
});

test('ensurePlaywright honours the opt-out and offline mode', async () => {
  const space = workspace('guard');
  assert.deepEqual(await ensurePlaywright({ ...space, env: { PORTABLE_AI_NO_PLAYWRIGHT: '1' } }), { skipped: 'disabled' });
  const offline = await ensurePlaywright({ ...space, env: {}, offline: true });
  assert.equal(offline.skipped, 'offline');
  assert.equal(space.calls.length, 0, 'no network work in either case');
});

test('a failed install degrades to a warning instead of breaking the start', async () => {
  const space = workspace('failure');
  const output = [];
  const runner = async () => { throw new Error('network unreachable'); };
  const result = await ensurePlaywright({ ...space, runner, env: {}, onOutput: text => output.push(text) });
  assert.match(result.failed, /network unreachable/);
  assert.match(output.join(''), /Playwright setup skipped/);
  assert.equal(result.status.ready, false);
});

test('update checks compare the pinned version with npm', async () => {
  const respond = version => async () => ({ ok: true, json: async () => ({ version }) });
  assert.deepEqual(await availablePlaywrightUpdate({ fetchImpl: respond('1.66.0') }), { current: PIN, latest: '1.66.0' });
  assert.equal(await availablePlaywrightUpdate({ fetchImpl: respond(PIN) }), null);
  assert.equal(await availablePlaywrightUpdate({ fetchImpl: respond('1.64.0') }), null, 'older releases are not an update');
  await assert.rejects(availablePlaywrightUpdate({ fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(availablePlaywrightUpdate({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /no version published/);
});

test('saving a pin writes the manifest and returns the previous value', () => {
  const file = join(temp, 'runtime-manifest.json');
  writeFileSync(file, JSON.stringify({ ...manifest }));
  const previous = manifest.playwright;
  try {
    const returned = savePlaywrightPin('9.9.9', file);
    assert.equal(returned, previous);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).playwright, '9.9.9');
    assert.equal(manifest.playwright, '9.9.9');
  } finally {
    manifest.playwright = previous;
  }
});
