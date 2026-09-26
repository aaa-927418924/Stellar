import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentFromPayload } from '../server/index.js';

const dataUrl = (mime, text) => `data:${mime};base64,${Buffer.from(text).toString('base64')}`;

test('画像以外のファイルも添付できる', () => {
  const text = attachmentFromPayload({ name: 'memo.txt', type: 'text/plain', data: dataUrl('text/plain', 'hello') });
  assert.equal(text.extension, 'txt');
  assert.equal(text.name, 'memo.txt');
  assert.equal(text.bytes.toString('utf8'), 'hello');
  const pdf = attachmentFromPayload({ name: 'doc.pdf', type: 'application/pdf', data: dataUrl('application/pdf', '%PDF') });
  assert.equal(pdf.extension, 'pdf');
  const noext = attachmentFromPayload({ name: 'LICENSE', type: '', data: dataUrl('', 'x') });
  assert.equal(noext.extension, 'bin');
});

test('不正な添付は拒否する', () => {
  assert.equal(attachmentFromPayload(null), null);
  assert.throws(() => attachmentFromPayload({ name: 'a.txt', data: 'not-a-data-url' }), /読み取れません/);
  const big = Buffer.alloc(8_000_001, 97).toString('base64');
  assert.throws(() => attachmentFromPayload({ name: 'big.bin', data: `data:application/octet-stream;base64,${big}` }), /8MB/);
});
