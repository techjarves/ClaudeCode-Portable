import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAYWRIGHT_SKILL, playwrightSkillMarkdown, skillDirectory, skillPath, syncPlaywrightSkill } from '../lib/skills.mjs';

const temp = mkdtempSync(join(tmpdir(), 'portable-skills-'));
test.after(() => rmSync(temp, { recursive: true, force: true }));
const ready = { ready: true };
const missing = { ready: false };

test('the skill carries the frontmatter Claude Code needs to list it', () => {
  const markdown = playwrightSkillMarkdown({ cli: '/x/engine/playwright/node_modules/playwright/cli.js', browsers: '/x/engine/playwright-browsers' });
  assert.match(markdown, /^---\n/);
  const [, frontmatter] = markdown.split('---');
  assert.match(frontmatter, new RegExp(`name: ${PLAYWRIGHT_SKILL}`));
  // The description is what the agent sees before loading the file: it has to say when to use it.
  assert.match(frontmatter, /description: .*screenshot/i);
  assert.match(frontmatter, /Use when/);
});

test('the document names the real paths and forbids npx', () => {
  const markdown = playwrightSkillMarkdown({ cli: '/x/engine/playwright/node_modules/playwright/cli.js', browsers: '/x/engine/playwright-browsers' });
  assert.match(markdown, /\/x\/engine\/playwright\/node_modules\/playwright\/cli\.js/);
  assert.match(markdown, /\/x\/engine\/playwright-browsers/);
  assert.match(markdown, /do not use `npx`/i);
  assert.match(markdown, /only-shell|headless/i);
});

test('the skill is written into the user profile and left alone afterwards', () => {
  const directory = join(temp, 'profile');
  const first = syncPlaywrightSkill(directory, { status: ready });
  assert.equal(first.written, true);
  assert.equal(first.file, skillPath(directory));
  assert.ok(readFileSync(first.file, 'utf8').includes(PLAYWRIGHT_SKILL));
  const second = syncPlaywrightSkill(directory, { status: ready });
  assert.equal(second.written, false, 'a second start does not rewrite the file');
});

test('without Playwright the skill is not advertised, and a stale one is removed', () => {
  const directory = join(temp, 'stale');
  syncPlaywrightSkill(directory, { status: ready });
  assert.ok(existsSync(skillPath(directory)));
  const result = syncPlaywrightSkill(directory, { status: missing });
  assert.equal(result.written, false);
  assert.equal(result.removed, true);
  assert.equal(existsSync(skillDirectory(directory)), false);
  // A user's own skill next to it must survive.
  mkdirSync(join(skillDirectory(directory), '..', 'mine'), { recursive: true });
  writeFileSync(join(directory, 'skills', 'mine', 'SKILL.md'), 'keep me');
  syncPlaywrightSkill(directory, { status: missing });
  assert.equal(readFileSync(join(directory, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'keep me');
});
