import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keybindingsPath, syncImagePasteKeybinding, withImagePasteBinding } from '../lib/keybindings.mjs';

const temp = mkdtempSync(join(tmpdir(), 'portable-keybindings-'));
test.after(() => rmSync(temp, { recursive: true, force: true }));
const ACTION = 'chat:imagePaste';

test('an empty configuration gets the ctrl+v binding', () => {
  const result = withImagePasteBinding({ $schema: 'x', bindings: [] });
  assert.deepEqual(result.bindings, [{ context: 'Chat', bindings: { 'ctrl+v': ACTION } }]);
});

test('a Chat block without ctrl+v is extended, not replaced', () => {
  const result = withImagePasteBinding({ bindings: [{ context: 'Chat', bindings: { 'ctrl+s': 'chat:stash' } }] });
  assert.deepEqual(result.bindings[0].bindings, { 'ctrl+s': 'chat:stash', 'ctrl+v': ACTION });
});

test('every other context and binding survives', () => {
  const result = withImagePasteBinding({
    bindings: [
      { context: 'Global', bindings: { 'ctrl+t': 'global:tasks' } },
      { context: 'Chat', bindings: { 'ctrl+g': 'chat:externalEditor' } },
    ],
  });
  assert.equal(result.bindings.length, 2);
  assert.deepEqual(result.bindings[0], { context: 'Global', bindings: { 'ctrl+t': 'global:tasks' } });
  assert.equal(result.bindings[1].bindings['ctrl+g'], 'chat:externalEditor');
  assert.equal(result.bindings[1].bindings['ctrl+v'], ACTION);
});

test('an explicit user choice always wins', () => {
  const custom = withImagePasteBinding({ bindings: [{ context: 'Chat', bindings: { 'ctrl+v': 'chat:newline' } }] });
  assert.equal(custom.bindings[0].bindings['ctrl+v'], 'chat:newline');
  const unbound = withImagePasteBinding({ bindings: [{ context: 'Chat', bindings: { 'ctrl+v': null } }] });
  assert.equal(unbound.bindings[0].bindings['ctrl+v'], null, 'an explicit unbind stays unbind');
});

test('an unexpected shape is reported instead of being overwritten', () => {
  assert.equal(withImagePasteBinding({ bindings: {} }), null);
  assert.equal(withImagePasteBinding([{ context: 'Chat' }]), null);
  assert.equal(withImagePasteBinding(null), null);
});

test('the file is written once and left alone afterwards', () => {
  const directory = join(temp, 'profile');
  const file = keybindingsPath(directory);
  assert.equal(syncImagePasteKeybinding(directory).changed, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).bindings[0].bindings['ctrl+v'], ACTION);
  assert.equal(syncImagePasteKeybinding(directory).changed, false, 'a second run is a no-op');
});

test('a file the user is editing is never clobbered', () => {
  const directory = join(temp, 'broken');
  const file = keybindingsPath(directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, '{ "bindings": [ oops');
  const result = syncImagePasteKeybinding(directory);
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'unreadable');
  assert.equal(readFileSync(file, 'utf8'), '{ "bindings": [ oops');
});
