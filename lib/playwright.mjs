import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';
import { manifest, npmCLI, run } from './runtime.mjs';

// Playwright lives next to the runtime so the browser automation travels with
// the drive: package in engine/playwright, binaries in engine/playwright-browsers.
// The version is pinned because it decides the Chromium build revision; an
// unpinned update would download every browser again.
export const PLAYWRIGHT_DIR = join(ROOT, 'engine', 'playwright');
export const PLAYWRIGHT_BROWSERS_DIR = join(ROOT, 'engine', 'playwright-browsers');
export const PLAYWRIGHT_CLI = join(PLAYWRIGHT_DIR, 'node_modules', 'playwright', 'cli.js');
const MANIFEST_FILE = join(ROOT, 'tools', 'runtime-manifest.json');

export const pinnedPlaywrightVersion = () => manifest.playwright || null;
export const playwrightDisabled = env => env.PORTABLE_AI_NO_PLAYWRIGHT === '1';

export function playwrightPackageVersion(directory = PLAYWRIGHT_DIR) {
  try {
    return JSON.parse(readFileSync(join(directory, 'node_modules', 'playwright', 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/**
 * The Chromium builds the installed package actually expects.
 *
 * Playwright ships `playwright-core/browsers.json` and names its download
 * directories `<name>-<revision>`. Comparing against those revisions catches an
 * interrupted upgrade that left an older `chromium*` directory behind: the
 * package is already at the pinned version, so a bare "any chromium directory"
 * check would call the installation ready and every launch would then fail.
 */
export function expectedBrowserBuilds(directory = PLAYWRIGHT_DIR) {
  try {
    const file = join(directory, 'node_modules', 'playwright-core', 'browsers.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return (Array.isArray(data?.browsers) ? data.browsers : [])
      .filter(entry => entry?.name === 'chromium' || entry?.name === 'chromium-headless-shell')
      .filter(entry => entry.revision !== undefined && entry.revision !== null)
      .map(entry => ({ name: entry.name, revision: String(entry.revision), directory: `${String(entry.name).replace(/-/g, '_')}-${entry.revision}` }));
  } catch {
    return [];
  }
}

export function playwrightBrowsersPresent(directory = PLAYWRIGHT_BROWSERS_DIR, { packageDirectory = PLAYWRIGHT_DIR } = {}) {
  let names;
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return false;
  }
  const expected = expectedBrowserBuilds(packageDirectory);
  // `install --only-shell chromium` fetches the headless shell, but a full
  // Chromium of the same revision serves just as well.
  if (expected.length) return expected.some(build => names.includes(build.directory));
  // No browsers.json to compare against means an unknown layout; fall back to
  // the loose check so this never triggers a full re-download on every start.
  return names.some(name => /^chromium/.test(name));
}

export function playwrightStatus({
  directory = PLAYWRIGHT_DIR,
  browsersDirectory = PLAYWRIGHT_BROWSERS_DIR,
  cli = PLAYWRIGHT_CLI,
  pinned = pinnedPlaywrightVersion(),
} = {}) {
  const installed = playwrightPackageVersion(directory);
  const browsers = playwrightBrowsersPresent(browsersDirectory, { packageDirectory: directory });
  return {
    pinned,
    installed,
    browsers,
    // Up to date means: the pinned package is present and the browser build
    // revision that package expects is installed.
    ready: !!pinned && installed === pinned && browsers,
    executable: existsSync(cli) ? cli : null,
  };
}

function installEnvironment() {
  return {
    ...process.env,
    // Absolute path is required: Playwright ignores relative values.
    PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_BROWSERS_DIR,
    // The npm package's own postinstall would fetch the full browser bundle; the
    // explicit `install --only-shell chromium` below decides what is downloaded.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  };
}

/**
 * Installs the pinned Playwright package and its headless Chromium build.
 *
 * Both steps are idempotent: an existing package is skipped unless `force` is
 * set, and Playwright itself detects installed browser builds. `--no-remove`
 * keeps browsers that were downloaded on another machine, because the .links
 * file stores absolute paths and a moved drive would otherwise make Playwright
 * treat them as orphaned.
 */
export async function installPlaywright({
  onOutput = () => {},
  version = pinnedPlaywrightVersion(),
  runner = run,
  force = false,
  directory = PLAYWRIGHT_DIR,
  browsersDirectory = PLAYWRIGHT_BROWSERS_DIR,
  cli = PLAYWRIGHT_CLI,
} = {}) {
  if (!version) throw new Error('No Playwright version is pinned in tools/runtime-manifest.json');
  mkdirSync(directory, { recursive: true });
  mkdirSync(browsersDirectory, { recursive: true });
  const env = { ...installEnvironment(), PLAYWRIGHT_BROWSERS_PATH: browsersDirectory };

  if (force || playwrightPackageVersion(directory) !== version) {
    onOutput(`Installing Playwright ${version}...\n`);
    await runner(process.execPath, [
      npmCLI(), 'install', '--prefix', directory,
      '--no-audit', '--no-fund', '--save=false', '--no-bin-links',
      `playwright@${version}`,
    ], { cwd: directory, env, onOutput });
  }

  onOutput('Installing the headless Chromium build for Playwright...\n');
  await runner(process.execPath, [
    cli, 'install', '--only-shell', 'chromium', '--no-progress', '--no-remove',
  ], { cwd: ROOT, env, onOutput });

  const status = playwrightStatus({ directory, browsersDirectory, cli, pinned: version });
  if (!status.ready) throw new Error('Playwright installation is incomplete. Run the install option again.');
  return status;
}

/** Installs only what is missing. Never throws: browser automation is optional. */
export async function ensurePlaywright({
  onOutput = () => {},
  runner = run,
  env = process.env,
  offline = false,
  directory = PLAYWRIGHT_DIR,
  browsersDirectory = PLAYWRIGHT_BROWSERS_DIR,
  cli = PLAYWRIGHT_CLI,
} = {}) {
  if (playwrightDisabled(env)) return { skipped: 'disabled' };
  const status = playwrightStatus({ directory, browsersDirectory, cli });
  if (status.ready) return { skipped: 'current', status };
  if (offline) {
    onOutput('Playwright is missing or out of date; skipping the download in offline mode.\n');
    return { skipped: 'offline', status };
  }
  try {
    return { installed: true, status: await installPlaywright({ onOutput, runner, directory, browsersDirectory, cli }) };
  } catch (error) {
    onOutput(`Playwright setup skipped: ${error.message}\n  Browser automation stays unavailable until the install option succeeds.\n`);
    return { failed: error.message, status: playwrightStatus({ directory, browsersDirectory, cli }) };
  }
}

function isNewerVersion(latest, current) {
  const parts = value => String(value).split('-')[0].split('.').map(Number);
  const newer = parts(latest), older = parts(current);
  for (let i = 0; i < 3; i++) {
    if ((newer[i] || 0) !== (older[i] || 0)) return (newer[i] || 0) > (older[i] || 0);
  }
  return false;
}

/** Compares the pinned Playwright version with the latest npm release. */
export async function availablePlaywrightUpdate({ fetchImpl = fetch } = {}) {
  const pinned = pinnedPlaywrightVersion();
  if (!pinned) return null;
  const response = await fetchImpl('https://registry.npmjs.org/playwright/latest', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Playwright update check failed: HTTP ${response.status}`);
  const latest = (await response.json()).version;
  if (typeof latest !== 'string') throw new Error('Playwright update check failed: no version published');
  return isNewerVersion(latest, pinned) ? { current: pinned, latest } : null;
}

/** Writes a new pin, returning the previous one so a failed install can roll back. */
export function savePlaywrightPin(version, file = MANIFEST_FILE) {
  const previous = manifest.playwright;
  manifest.playwright = version;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return previous;
}
