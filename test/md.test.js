import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAiText, escapeHtml, renderInlineHtml, unescapeHtml } from '../public/md.js';

test('HTMLを無害化して太字・斜体・コード・リンクを表示する', () => {
  assert.equal(
    renderInlineHtml(escapeHtml('**太字**と*斜体*と`code`')),
    '<strong>太字</strong>と<em>斜体</em>と<code>code</code>'
  );
  assert.equal(
    renderInlineHtml(escapeHtml('[検索](https://example.com/x)')),
    '<a href="https://example.com/x" target="_blank" rel="noreferrer">検索</a>'
  );
  assert.equal(
    renderInlineHtml(escapeHtml('[危険](javascript:alert(1))')),
    '[危険](javascript:alert(1))'
  );
  assert.equal(
    renderInlineHtml(escapeHtml('<script>alert(1)</script>')),
    '&lt;script&gt;alert(1)&lt;/script&gt;'
  );
  assert.equal(
    renderInlineHtml(escapeHtml('`a*b` と **b**')),
    '<code>a*b</code> と <strong>b</strong>'
  );
});

test('エスケープと復元が往復する', () => {
  assert.equal(unescapeHtml(escapeHtml('<a href="x">&</a>')), '<a href="x">&</a>');
  assert.equal(cleanAiText('\\(a\\)'), 'a');
});
