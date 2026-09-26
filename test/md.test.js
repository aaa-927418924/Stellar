import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAiText, convertLatexMath, escapeHtml, parseTableBlock, renderInlineHtml, unescapeHtml } from '../public/md.js';

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

test('数式は等幅で表示する', () => {
  assert.equal(
    renderInlineHtml(escapeHtml('$\\1/2 + \\1/3 = \\5/6$')),
    '<code class="md-math">1/2 + 1/3 = 5/6</code>'
  );
  assert.equal(
    renderInlineHtml(escapeHtml('- 傾きが $2$ なら $x$ が $1$ 増える')),
    '- 傾きが <code class="md-math">2</code> なら <code class="md-math">x</code> が <code class="md-math">1</code> 増える'
  );
  assert.equal(
    renderInlineHtml(escapeHtml('`$x$` と $a+b$')),
    '<code>$x$</code> と <code class="md-math">a+b</code>'
  );
});

test('表ブロックを認識する', () => {
  const table = parseTableBlock(['| 名前 | 点 |', '| --- | ---: |', '| A | 90 |', '| B | 80 |']);
  assert.deepEqual(table.header, ['名前', '点']);
  assert.deepEqual(table.align, ['', 'right']);
  assert.deepEqual(table.body, [['A', '90'], ['B', '80']]);
  assert.equal(parseTableBlock(['| A |', 'ただの文']), null);
  assert.equal(parseTableBlock(['| A | B |', '| --- |', '| C |']), null);
});

test('LaTeX数式を読みやすく変換する', () => {
  assert.equal(
    convertLatexMath('\\begin{aligned}\nx + y &amp;= 3 \\\\\n2x - y &amp;= 0\n\\end{aligned}'),
    'x + y  = 3\n2x - y  = 0'
  );
  assert.equal(convertLatexMath('\\alpha + \\beta = \\gamma'), 'α + β = γ');
  assert.equal(convertLatexMath('\\sqrt{x} + \\frac{a}{b}'), '√(x) + (a)/(b)');
  assert.equal(convertLatexMath('a^2 + b^2 = c^2'), 'a^2 + b^2 = c^2');
});
