const assert = require('node:assert');
const { renderMarkdown: md } = require('../media/markdown');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}
const has = (html, frag) => assert.ok(html.includes(frag), `expected ${frag}\n       in ${html}`);
const lacks = (html, frag) => assert.ok(!html.includes(frag), `did not expect ${frag}\n       in ${html}`);

console.log('\nmarkdown');
t('headings, bold, italic, inline code', () => {
  const h = md('## Title\nSome **bold**, *it* and `x < y`.');
  has(h, '<h2>Title</h2>'); has(h, '<strong>bold</strong>'); has(h, '<em>it</em>');
  has(h, '<code>x &lt; y</code>');
});
t('escapes raw html from the model', () => {
  const h = md('<img src=x onerror=alert(1)> **<b>**');
  lacks(h, '<img'); lacks(h, '<b>'); has(h, '&lt;img');
});
t('does not italicise snake_case', () => {
  lacks(md('call my_var_name here'), '<em>');
});
t('markdown inside code spans is left alone', () => {
  has(md('`**not bold**`'), '<code>**not bold**</code>');
});
t('fenced code keeps Copy/Insert with the raw code', () => {
  const h = md('Text\n```ts\nconst a = 1 < 2;\n```\nAfter');
  has(h, '<div class="lang">ts</div>'); has(h, 'const a = 1 &lt; 2;');
  has(h, 'data-insert="' + encodeURIComponent('const a = 1 < 2;') + '"');
  has(h, '<p>After</p>');
});
t('unterminated fence (mid-stream) renders as code without actions', () => {
  const h = md('```py\nprint("hi")');
  has(h, '<pre><code>print(&quot;hi&quot;)</code></pre>'); lacks(h, 'data-copy');
});
t('bullet list with nested ordered list', () => {
  const h = md('- one\n- two\n  1. a\n  2. b\n- three');
  has(h, '<ul><li><div>one</div></li><li><div>two</div><ol><li><div>a</div></li>');
  has(h, '<li><div>three</div></li></ul>');
});
t('ordered list keeps its start number', () => {
  has(md('3. c\n4. d'), '<ol start="3">');
});
t('a bullet list after a numbered one is a separate list', () => {
  const h = md('1. a\n2. b\n\n* c\n* d');
  has(h, '<ol><li><div>a</div></li><li><div>b</div></li></ol><ul><li><div>c</div></li>');
});
t('code fence inside a list item', () => {
  const h = md('1. Run:\n   ```sh\n   npm test\n   ```\n2. Done');
  has(h, '<pre><code>npm test</code></pre>'); has(h, '<li><div>Done</div></li>');
});
t('table with alignment', () => {
  const h = md('| a | b |\n|:--|--:|\n| 1 | `2` |');
  has(h, '<th style="text-align:left">a</th>'); has(h, '<td style="text-align:right"><code>2</code></td>');
});
t('blockquote and hr', () => {
  const h = md('> quoted\n\n---');
  has(h, '<blockquote><p>quoted</p></blockquote>'); has(h, '<hr>');
});
t('only safe link schemes become anchors', () => {
  has(md('[docs](https://example.com)'), '<a href="https://example.com"');
  lacks(md('[x](javascript:alert(1))'), '<a');
});
t('single newlines inside a paragraph are kept', () => {
  has(md('line one\nline two'), 'line one<br>line two');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
