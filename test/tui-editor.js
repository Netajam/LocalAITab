// The terminal prompt's vim editing, key by key, checked against what vim does.
const assert = require('node:assert');
const { draftOf, edit } = require('../out/hosts/tui/terminal/editor');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const NAMED = { '<cr>': 'return', '<bs>': 'backspace', '<left>': 'left', '<up>': 'up', '<down>': 'down' };
/** Types a vim-style key string: plain characters, <esc>/<cr>/<bs>/<left>/<up>/<down>, <c-x>, <m-cr>. */
function type(draft, keys) {
  const events = [];
  for (const tok of keys.match(/<[^>]+>|[\s\S]/g)) {
    let key;
    // Esc as a terminal reports it: Node sets meta on a lone escape.
    if (tok === '<esc>') key = { name: 'escape', meta: true, sequence: '\x1b' };
    else if (NAMED[tok]) key = { name: NAMED[tok], sequence: '' };
    else if (tok === '<m-cr>') key = { name: 'return', meta: true, sequence: '\x1b\r' };
    else if (/^<c-.>$/.test(tok)) key = { name: tok[3], ctrl: true, sequence: '' };
    else key = { name: tok.toLowerCase(), sequence: tok };
    const r = edit(draft, key);
    draft = r.draft;
    if (r.event) events.push(r.event);
  }
  draft.events = events;
  return draft;
}
/** Starts in normal mode on `text` with the cursor at the `|`. */
function at(marked) {
  const cursor = marked.indexOf('|');
  return { ...draftOf(marked.replace('|', '')), cursor, mode: 'normal' };
}
const show = (d) => d.text.slice(0, d.cursor) + '|' + d.text.slice(d.cursor);

console.log('\ninsert mode');
t('typing inserts at the cursor', () => assert.equal(show(type(draftOf(), 'hello<left><left>XY')), 'helXY|lo'));
t('Enter submits', () => assert.deepEqual(type(draftOf('hi'), '<cr>').events, ['submit']));
t('Alt+Enter and a trailing backslash make a newline', () => {
  assert.equal(type(draftOf('a'), '<m-cr>b').text, 'a\nb');
  const d = type(draftOf('a\\'), '<cr>b');
  assert.equal(d.text, 'a\nb'); assert.deepEqual(d.events, []);
});
t('Ctrl+W deletes the word before the cursor', () => assert.equal(show(type(draftOf('fix the bug'), '<c-w>')), 'fix the |'));
t('Ctrl+U clears to the line start, Ctrl+K to its end', () => {
  assert.equal(show(type(draftOf('abc def'), '<left><left><left><c-u>')), '|def');
  assert.equal(show(type(draftOf('abc def'), '<left><left><left><c-k>')), 'abc |');
});
t('Up on the first line asks for history', () => assert.deepEqual(type(draftOf('x'), '<up>').events, ['history-prev']));
t('Esc steps back onto the last character', () => {
  const d = type(draftOf('abc'), '<esc>');
  assert.equal(d.mode, 'normal'); assert.equal(show(d), 'ab|c');
});

console.log('\nnormal mode motions');
t('w b e', () => {
  assert.equal(show(type(at('|foo bar.baz'), 'w')), 'foo |bar.baz');
  assert.equal(show(type(at('|foo bar.baz'), 'ww')), 'foo bar|.baz');
  assert.equal(show(type(at('|foo bar.baz'), 'W')), 'foo |bar.baz');
  assert.equal(show(type(at('foo bar.ba|z'), 'b')), 'foo bar.|baz');
  assert.equal(show(type(at('|foo bar'), 'e')), 'fo|o bar');
});
t('0 ^ $ and counts', () => {
  assert.equal(show(type(at('  ab|cd'), '0')), '|  abcd');
  assert.equal(show(type(at('  ab|cd'), '^')), '  |abcd');
  assert.equal(show(type(at('|abcd'), '$')), 'abc|d');
  assert.equal(show(type(at('|a b c d'), '3w')), 'a b c |d');
});
t('f t F T', () => {
  assert.equal(show(type(at('|call(a, b)'), 'f,')), 'call(a|, b)');
  assert.equal(show(type(at('|call(a, b)'), 't,')), 'call(|a, b)');
  assert.equal(show(type(at('call(a, |b)'), 'F(')), 'call|(a, b)');
});
t('j k keep the column, and ask for history past the ends', () => {
  assert.equal(show(type(at('ab|c\ndef'), 'j')), 'abc\nde|f');
  assert.deepEqual(type(at('ab|c'), 'k').events, ['history-prev']);
});
t('gg and G', () => {
  assert.equal(show(type(at('one\ntwo\nth|ree'), 'gg')), '|one\ntwo\nthree');
  assert.equal(show(type(at('|one\ntwo'), 'G')), 'one\n|two');
});

console.log('\noperators');
t('dw de db d$ D', () => {
  assert.equal(show(type(at('|foo bar'), 'dw')), '|bar');
  assert.equal(show(type(at('|foo bar'), 'de')), '| bar');
  assert.equal(show(type(at('foo |bar'), 'db')), '|bar');
  assert.equal(show(type(at('fo|o bar'), 'd$')), 'f|o');
  assert.equal(show(type(at('fo|o bar'), 'D')), 'f|o');
});
t('dw on the last word stops at the line end', () => assert.equal(type(at('a |bc\nnext'), 'dw').text, 'a \nnext'));
t('d$ on an empty line keeps the newline', () => assert.equal(type(at('a\n|\nb'), 'd$').text, 'a\n\nb'));
t('cw changes to the end of the word, even a one-letter one', () => {
  const d = type(at('|foo bar'), 'cwX');
  assert.equal(show(d), 'X| bar'); assert.equal(d.mode, 'insert');
  assert.equal(type(at('|a bc'), 'cwX').text, 'X bc');
});
t('dd, 2dd, dj and cc work on lines', () => {
  assert.equal(show(type(at('one\ntw|o\nthree'), 'dd')), 'one\n|three');
  assert.equal(type(at('|one\ntwo\nthree'), '2dd').text, 'three');
  assert.equal(type(at('|one\ntwo\nthree'), 'dj').text, 'three');
  assert.equal(show(type(at('one\n  tw|o'), 'ccX')), 'one\nX|');
});
t('dt) and df,', () => {
  assert.equal(type(at('f(|a, b)'), 'dt)').text, 'f()');
  assert.equal(type(at('|a, b'), 'df,').text, ' b');
});
t('x X s r ~ J', () => {
  assert.equal(show(type(at('a|bc'), 'x')), 'a|c');
  assert.equal(show(type(at('a|bc'), '2x')), '|a');
  assert.equal(show(type(at('ab|c'), 'X')), 'a|c');
  assert.equal(type(at('a|bc'), 'sZ').text, 'aZc');
  assert.equal(type(at('a|bc'), 'rZ').text, 'aZc');
  assert.equal(type(at('|ab'), '~~').text, 'AB');
  assert.equal(type(at('|one\n  two'), 'J').text, 'one two');
});
t('yank and paste, by character and by line', () => {
  assert.equal(type(at('|foo bar'), 'ywP').text, 'foo foo bar');
  assert.equal(type(at('|one\ntwo'), 'yyjp').text, 'one\ntwo\none');
  assert.equal(type(at('|ab'), 'xp').text, 'ba');
});
t('i a I A o O enter insert where vim does', () => {
  assert.equal(show(type(at('a|bc'), 'iX')), 'aX|bc');
  assert.equal(show(type(at('a|bc'), 'aX')), 'abX|c');
  assert.equal(show(type(at('  a|bc'), 'IX')), '  X|abc');
  assert.equal(show(type(at('a|bc'), 'AX')), 'abcX|');
  assert.equal(show(type(at('a|b\nc'), 'oX')), 'ab\nX|\nc');
  assert.equal(show(type(at('a|b'), 'OX')), 'X|\nab');
});

console.log('\nundo');
t('u undoes a whole insert, Ctrl+R redoes it', () => {
  const typed = type(draftOf(), 'hello world<esc>');
  const undone = type(typed, 'u');
  assert.equal(undone.text, '');
  assert.equal(type(undone, '<c-r>').text, 'hello world');
});
t('u undoes operators one at a time', () => {
  const d = type(at('|a b c'), 'dwdw');
  assert.equal(d.text, 'c');
  assert.equal(type(d, 'u').text, 'b c');
  assert.equal(type(d, 'uu').text, 'a b c');
});
t('Enter in normal mode submits', () => assert.deepEqual(type(at('|x'), '<cr>').events, ['submit']));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
