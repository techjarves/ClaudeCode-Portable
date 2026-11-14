import test from 'node:test';
import assert from 'node:assert/strict';
import { isComposerSubmitKey } from '../dashboard/composer.js';

test('composer does not submit while an IME composition is active',()=>{
  const enter={key:'Enter',shiftKey:false,isComposing:false};
  assert.equal(isComposerSubmitKey(enter,true),false);
});

test('composer uses Enter to submit outside an IME composition',()=>{
  assert.equal(isComposerSubmitKey({key:'Enter',shiftKey:false,isComposing:false}),true);
  assert.equal(isComposerSubmitKey({key:'Enter',shiftKey:true,isComposing:false}),false);
  assert.equal(isComposerSubmitKey({key:'Enter',shiftKey:false,isComposing:true}),false);
});
