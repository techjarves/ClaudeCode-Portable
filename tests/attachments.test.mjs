import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES, removeAttachments, resolveAttachments, saveAttachments } from '../lib/attachments.mjs';

test('attachments are stored under their session and resolved only by opaque IDs',()=>{
  const root=mkdtempSync(join(tmpdir(),'portable-attachments-')),session='12345678-1234-1234-1234-123456789abc';
  try{
    const [saved]=saveAttachments(session,[{name:'../project.zip',type:'application/zip',data:Buffer.from('fixture zip').toString('base64')}],root);
    assert.equal(saved.name,'project.zip');assert.equal(saved.size,11);assert.match(saved.id,/^[a-f0-9-]{36}$/);
    const [resolved]=resolveAttachments(session,[saved.id],root);assert.equal(resolved.name,'project.zip');assert.ok(resolved.path.startsWith(join(root,session)));
    assert.throws(()=>resolveAttachments(session,['../../secret']),/Invalid attachments/);
    removeAttachments(session,root);assert.equal(existsSync(join(root,session)),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('attachment limits reject empty and oversized payloads',()=>{
  const root=mkdtempSync(join(tmpdir(),'portable-attachments-')),session='12345678-1234-1234-1234-123456789abc';
  try{
    assert.throws(()=>saveAttachments(session,[],root),/between 1 and 10/);
    assert.throws(()=>saveAttachments(session,[{name:'large.bin',data:Buffer.alloc(MAX_ATTACHMENT_BYTES+1).toString('base64')}],root),/Invalid attachment data|10 MB/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
