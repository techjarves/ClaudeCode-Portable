import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineCodePath, isFilePath, linkifyText, trimPath } from '../dashboard/links.js';
import { openLocalPath, openerFor } from '../lib/open-path.mjs';

test('only absolute local paths count as files', () => {
  assert.equal(isFilePath('D:\\Apps\\bild.png'), true);
  assert.equal(isFilePath('C:/Users/x/notes.txt'), true);
  assert.equal(isFilePath('\\\\server\\share\\file.pdf'), true);
  assert.equal(isFilePath('file:///D:/Apps/bild.png'), true);
  // Relative fragments stay plain text: they mean nothing outside a project.
  assert.equal(isFilePath('src/app.ts'), false);
  assert.equal(isFilePath('package.json'), false);
  assert.equal(isFilePath('https://example.com/a'), false);
});

test('trailing punctuation belongs to the sentence, not the path', () => {
  assert.deepEqual(trimPath('D:\\Apps\\bild.png.'), { path: 'D:\\Apps\\bild.png', leading: '', trailing: '.' });
  assert.deepEqual(trimPath('D:\\Apps\\bild.png'), { path: 'D:\\Apps\\bild.png', leading: '', trailing: '' });
  assert.deepEqual(trimPath('D:\\a\\b),'), { path: 'D:\\a\\b', leading: '', trailing: '),' });
  assert.deepEqual(trimPath('"C:\\a b\\c.txt"'), { path: 'C:\\a b\\c.txt', leading: '"', trailing: '"' });
});

test('a windows path becomes a clickable button', () => {
  const html = linkifyText('Saved to D:\\Apps\\bild.png for you.');
  assert.match(html, /<button type="button" class="path-link" data-open-path="D:\\Apps\\bild\.png"/);
  assert.match(html, />D:\\Apps\\bild\.png<\/button>/);
  assert.match(html, /^Saved to /);
  assert.match(html, / for you\.$/);
});

test('text without paths is returned byte for byte', () => {
  const text = 'Nothing to see here, just src/app.ts and a sentence.';
  assert.equal(linkifyText(text), text);
});

test('several paths and a file URL in one line', () => {
  const html = linkifyText('D:\\one.txt and D:\\two.txt plus file:///D:/three.txt');
  assert.equal((html.match(/class="path-link"/g) || []).length, 3);
});

test('a path containing an ampersand is escaped', () => {
  const html = linkifyText('D:\\A&B\\x.txt');
  assert.match(html, /data-open-path="D:\\A&amp;B\\x\.txt"/);
  assert.doesNotMatch(html, /data-open-path="D:\\A&B/);
});

test('a quoted path keeps its spaces, the quotes do not join the link', () => {
  const html = linkifyText('See "C:\\Program Files\\App\\notes.txt" for details.');
  assert.match(html, /data-open-path="C:\\Program Files\\App\\notes\.txt"/);
  assert.doesNotMatch(html, /data-open-path="[^"]*notes\.txt for/);
});

test('an unquoted path stops at whitespace', () => {
  const html = linkifyText('Saved to D:\\Apps\\bild.png for you.');
  assert.match(html, /data-open-path="D:\\Apps\\bild\.png"/);
  assert.match(html, / for you\.$/);
});

test('inline code holds its whole value, spaces included', () => {
  // This is the case from the studio: a path in backticks with a space in it.
  assert.equal(inlineCodePath('D:\\Apps\\Claude Code\\data\\die-odyssee-poster.jpg'), 'D:\\Apps\\Claude Code\\data\\die-odyssee-poster.jpg');
  assert.equal(inlineCodePath('C:\\Users\\Karlheinz\\AppData\\Local\\Temp\\claude\\x\\images\\1.jpg'), 'C:\\Users\\Karlheinz\\AppData\\Local\\Temp\\claude\\x\\images\\1.jpg');
  assert.equal(inlineCodePath('file:///D:/a/b.png'), 'file:///D:/a/b.png');
});

test('inline code with two paths or no path stays plain', () => {
  assert.equal(inlineCodePath('D:\\a\\b.txt und C:\\c\\d.txt'), null);
  assert.equal(inlineCodePath('npm run build'), null);
  assert.equal(inlineCodePath('D:\\a\\b.txt\nC:\\c\\d.txt'), null);
  assert.equal(inlineCodePath(''), null);
});

test('the opener never builds a shell command line', async () => {
  assert.deepEqual(openerFor('win32'), { command: 'explorer.exe', args: [] });
  assert.equal(openerFor('darwin').command, 'open');
  assert.equal(openerFor('linux').command, 'xdg-open');
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const emitter = { once(event, handler) { if (event === 'spawn') setImmediate(handler); return emitter; }, unref() {} };
    return emitter;
  };
  await openLocalPath('D:\\A & B\\x.txt', { platform: 'win32', spawnImpl: fakeSpawn });
  assert.equal(calls[0].command, 'explorer.exe');
  // The path is one argument, so shell metacharacters stay literal.
  assert.deepEqual(calls[0].args, ['D:\\A & B\\x.txt']);
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.detached, true);
});

test('a spawn failure rejects instead of hanging', async () => {
  const failing = () => { const e = { once(event, handler) { if (event === 'error') setImmediate(() => handler(new Error('spawn failed'))); return e; }, unref() {} }; return e; };
  await assert.rejects(openLocalPath('D:\\x.txt', { platform: 'win32', spawnImpl: failing }), /spawn failed/);
});
