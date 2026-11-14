import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYWRIGHT_BROWSERS_DIR, PLAYWRIGHT_CLI, playwrightStatus } from './playwright.mjs';

// A session knows nothing about the portable folders unless it is told. Claude
// Code discovers skills in the profile directory (settingSources 'user' points
// CLAUDE_CONFIG_DIR there) and lists their name and description in the system
// prompt, so the agent learns that Playwright exists without paying for the
// whole document until it needs it.
export const PLAYWRIGHT_SKILL = 'portable-playwright';

export function skillDirectory(directory, name = PLAYWRIGHT_SKILL) {
  return join(directory, 'skills', name);
}

export function skillPath(directory, name = PLAYWRIGHT_SKILL) {
  return join(skillDirectory(directory, name), 'SKILL.md');
}

export function playwrightSkillMarkdown({ cli = PLAYWRIGHT_CLI, browsers = PLAYWRIGHT_BROWSERS_DIR } = {}) {
  return `---
name: ${PLAYWRIGHT_SKILL}
description: Take screenshots and drive a real browser with the portable Playwright installation that ships with this project. Use when a task needs a screenshot, a visual check of a local or remote page, a PDF, or automation of a JavaScript-heavy site that plain HTTP fetching cannot handle.
---

# Portable Playwright

This project bundles Playwright next to the runtime. Do not install anything and do not use \`npx\`: the
browsers are already downloaded and a second copy would land in the npx cache.

- CLI: \`${cli}\`
- Browsers: \`${browsers}\` (headless Chromium only)

## Screenshot a page

\`\`\`bash
"${cli}" screenshot --viewport-size="1440,900" --wait-for-timeout=3000 "https://example.com" shot.png
\`\`\`

Useful flags: \`--full-page\`, \`--wait-for-selector=".ready"\`, \`--device="iPhone 13"\`.

## Automate in a script

\`\`\`js
import { chromium } from 'file:///${cli.replace(/cli\.js$/, 'index.mjs').replace(/\\/g, '/')}';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:3000');
await page.screenshot({ path: 'shot.png' });
await browser.close();
\`\`\`

Set \`PLAYWRIGHT_BROWSERS_PATH\` to the browsers folder above when the environment does not already
provide it; a session started by this project inherits it.

## Limits

- Only the **headless shell** is installed. Headed browsing, video, and H.264 (for example live TV
  streams) need the full Chromium: run the launcher's \`install\` option after removing \`--only-shell\`
  in \`lib/playwright.mjs\`.
- Browsers are pinned by the Playwright version in \`tools/runtime-manifest.json\`. Do not upgrade the
  package by hand; use the launcher's update check so package and browser build stay in step.
- A message from the launcher such as "Playwright setup skipped" means the download failed and browser
  automation is unavailable; do not retry the install on your own, report it instead.
`;
}

/**
 * Writes the skill into the profile directory. Without Playwright the skill is
 * removed again: advertising browser automation that cannot run only sends the
 * agent into a dead end.
 */
export function syncPlaywrightSkill(directory, { status = playwrightStatus(), markdown } = {}) {
  const file = skillPath(directory);
  if (!status?.ready) {
    // Only this project's own skill is removed, never anything the user added.
    const removed = existsSync(file);
    if (removed) rmSync(skillDirectory(directory), { recursive: true, force: true });
    return { written: false, removed, reason: 'not-installed' };
  }
  mkdirSync(skillDirectory(directory), { recursive: true, mode: 0o700 });
  const next = markdown ?? playwrightSkillMarkdown();
  if (existsSync(file) && readFileSync(file, 'utf8') === next) return { file, written: false };
  writeFileSync(file, next, { mode: 0o600 });
  return { file, written: true };
}
