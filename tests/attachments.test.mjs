import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, detectImageType, removeAttachments, resolveAttachments, saveAttachments } from '../lib/attachments.mjs';

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

// Minimal but valid magic-byte prefixes for the formats a browser can paste.
const pngHeader=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
const jpegHeader=Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0]);
const webpHeader=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBP')]);

test('pasted images are recognised by their bytes, not by the reported type',()=>{
  assert.equal(detectImageType(pngHeader),'image/png');
  assert.equal(detectImageType(jpegHeader),'image/jpeg');
  assert.equal(detectImageType(webpHeader),'image/webp');
  assert.equal(detectImageType(Buffer.from('GIF89a......')),'image/gif');
  assert.equal(detectImageType(Buffer.from('not an image')),null);
  assert.equal(detectImageType(Buffer.alloc(0)),null);
});

test('image attachments keep their MIME type and expose data only when asked',()=>{
  const root=mkdtempSync(join(tmpdir(),'portable-attachments-')),session='12345678-1234-1234-1234-123456789abc';
  try{
    // A clipboard screenshot arrives as octet-stream with no useful name.
    const [saved]=saveAttachments(session,[{name:'pasted.png',type:'application/octet-stream',data:pngHeader.toString('base64')}],root);
    assert.equal(saved.type,'image/png');
    const [metadataOnly]=resolveAttachments(session,[saved.id],root);
    assert.equal(metadataOnly.type,'image/png');
    assert.equal(metadataOnly.data,undefined);
    const [withData]=resolveAttachments(session,[saved.id],root,{withData:true});
    assert.equal(withData.data,pngHeader.toString('base64'));
    // Non-image attachments never carry their payload.
    const [doc]=saveAttachments(session,[{name:'notes.txt',type:'text/plain',data:Buffer.from('hello').toString('base64')}],root);
    assert.equal(resolveAttachments(session,[doc.id],root,{withData:true})[0].data,undefined);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('images have their own, lower limit because they travel as base64',()=>{
  const root=mkdtempSync(join(tmpdir(),'portable-attachments-')),session='12345678-1234-1234-1234-123456789abc';
  try{
    const tooLarge=Buffer.concat([pngHeader,Buffer.alloc(MAX_IMAGE_BYTES)]);
    assert.throws(()=>saveAttachments(session,[{name:'huge.png',type:'image/png',data:tooLarge.toString('base64')}],root),/image must be 5 MB/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
