import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'portable-websearch-'));
process.env.PORTABLE_AI_DATA_DIR = join(temp, 'data');
const { WEBSEARCH_SKILL, webSearchSkillDirectory, webSearchSkillMarkdown, webSearchSkillPath, syncWebSearchSkill, webSearchEnabled, setWebSearch } = await import('../lib/websearch.mjs');
const { readConfig } = await import('../lib/config.mjs');
const { setBypassPermissions } = await import('../lib/permissions.mjs');

test.after(() => rmSync(temp, { recursive: true, force: true }));

test('the skill carries the frontmatter Claude Code needs to list it', () => {
  const markdown = webSearchSkillMarkdown();
  assert.match(markdown, /^---\n/);
  const [, frontmatter] = markdown.split('---');
  assert.match(frontmatter, new RegExp(`name: ${WEBSEARCH_SKILL}`));
  // The description is all the agent sees until it loads the file.
  assert.match(frontmatter, /description: .*search/i);
  assert.match(frontmatter, /Use whenever/);
});

test('the document names the endpoints that were verified to work', () => {
  const markdown = webSearchSkillMarkdown();
  // WebSearch itself is a server-side tool the other providers reject.
  assert.match(markdown, /web_search_20250305/);
  // Verified in a real session: Bing answers, Google News answers, DDG shows a bot check.
  assert.match(markdown, /bing\.com\/search\?q=/);
  assert.match(markdown, /news\.google\.com\/rss\/search\?q=/);
  assert.match(markdown, /duckduckgo\.com/i);
  // Fetched text is data, not instructions.
  assert.match(markdown, /never as instructions/i);
});

test('the skill is written into the profile and left alone afterwards', () => {
  const directory = join(temp, 'profile');
  const first = syncWebSearchSkill(directory);
  assert.equal(first.written, true);
  assert.equal(first.file, webSearchSkillPath(directory));
  assert.ok(readFileSync(first.file, 'utf8').includes(WEBSEARCH_SKILL));
  const second = syncWebSearchSkill(directory);
  assert.equal(second.written, false, 'a second start does not rewrite the file');
});

test('turning it off removes only this skill and keeps a user skill', () => {
  const directory = join(temp, 'off');
  syncWebSearchSkill(directory);
  mkdirSync(join(directory, 'skills', 'mine'), { recursive: true });
  writeFileSync(join(directory, 'skills', 'mine', 'SKILL.md'), 'keep me');

  const result = syncWebSearchSkill(directory, { enabled: false });
  assert.equal(result.removed, true);
  assert.equal(existsSync(webSearchSkillDirectory(directory)), false);
  assert.equal(readFileSync(join(directory, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'keep me');
});

test('the preference defaults to on and only an explicit off disables it', () => {
  // A fresh install searches without being told.
  assert.equal(webSearchEnabled({}), true);
  assert.equal(webSearchEnabled({ webSearch: undefined }), true);
  assert.equal(webSearchEnabled({ webSearch: true }), true);
  // Off is a deliberate manual act.
  assert.equal(webSearchEnabled({ webSearch: false }), false);
});

test('every launch path writes the skill through providerEnvironment', async () => {
  // The launcher, resume and the studio all build their environment here, so
  // this is the one place the skill can be missed for one of them.
  const { providerEnvironment } = await import('../lib/providers.mjs');
  const profile = { provider: 'deepseek', auth: 'api', model: 'm', baseUrl: 'https://api.deepseek.com/anthropic', key: 'k' };
  const directory = join(temp, 'data', 'claude', 'deepseek-api');
  rmSync(join(directory, 'skills', WEBSEARCH_SKILL), { recursive: true, force: true });

  // Default: written.
  providerEnvironment(profile, { parent: { PATH: '/usr/bin' } });
  assert.ok(existsSync(webSearchSkillPath(directory)), 'the skill is written by default');

  // Off: removed again, and the preference is the only switch.
  rmSync(join(directory, 'skills', WEBSEARCH_SKILL), { recursive: true, force: true });
  providerEnvironment(profile, { parent: { PATH: '/usr/bin' }, preferences: { webSearch: false } });
  assert.equal(existsSync(webSearchSkillPath(directory)), false, 'the preference keeps it out');
});

test('the switch is stored in data/settings.json and leaves other preferences alone', async () => {
  await setWebSearch(true);
  assert.equal(readConfig().preferences.webSearch, true);
  // The permissions preference next to it must survive the write.
  setBypassPermissions(false);
  await setWebSearch(false);
  const config = readConfig();
  assert.equal(config.preferences.webSearch, false);
  assert.equal(config.preferences.bypassPermissions, false, 'the other preference is untouched');
  await setWebSearch(true);
  const after = readConfig();
  assert.equal(after.preferences.webSearch, true);
  assert.equal(after.preferences.bypassPermissions, false, 'still untouched after re-enabling');
});
