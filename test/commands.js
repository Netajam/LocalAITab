const assert = require('node:assert');
const { parseCommand, suggest } = require('../media/commands');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

console.log('\nslash commands');
t('ordinary text is not a command', () => {
  assert.equal(parseCommand('why does /attach fail?'), null);
  assert.equal(parseCommand('a/b'), null);
});
t('parses a bare command', () => {
  assert.deepEqual(parseCommand('/help'), { name: 'help', arg: '' });
});
t('parses a command with an argument, trimmed', () => {
  assert.deepEqual(parseCommand('  /attach   src/chat.ts  '), { name: 'attach', arg: 'src/chat.ts' });
});
t('keeps spaces and newlines inside the argument', () => {
  assert.deepEqual(parseCommand('/find where the\ncontext meter is'), { name: 'find', arg: 'where the\ncontext meter is' });
});
t('/operator is a built-in mode switch', () => {
  assert.deepEqual(parseCommand('/operator'), { name: 'operator', arg: '' });
});
t('names are case-insensitive', () => {
  assert.equal(parseCommand('/ATTACH x').name, 'attach');
});
t('unknown commands report an error instead of being sent', () => {
  assert.match(parseCommand('/frobnicate').error, /Unknown command \/frobnicate/);
});
t('a required argument is enforced', () => {
  assert.match(parseCommand('/find').error, /needs/);
  assert.equal(parseCommand('/attach').error, undefined);
});
t('a double slash escapes', () => {
  assert.equal(parseCommand('//attach is a word here'), null);
});
t('a path-like message is not mistaken for a command', () => {
  assert.equal(parseCommand('/usr/bin/env is missing'), null);
});

console.log('\nsuggestions');
t('a lone slash lists everything', () => assert.ok(suggest('/').length >= 8));
t('filters by prefix', () => assert.deepEqual(suggest('/at').map((c) => c.name), ['attach']));
t('stops once an argument is being typed', () => assert.deepEqual(suggest('/attach '), []));
t('nothing for ordinary text', () => assert.deepEqual(suggest('hello'), []));

console.log('\nskills as commands');
const skills = [{ name: 'review-pr', arg: '<number>', help: 'Review a PR' }, { name: 'attach', help: 'shadow' }];
t('a skill parses with skill set', () => {
  assert.deepEqual(parseCommand('/review-pr 12', skills), { name: 'review-pr', arg: '12', skill: true });
});
t('a skill is unknown without the list', () => {
  assert.match(parseCommand('/review-pr 12').error, /Unknown command/);
});
t('a skill cannot replace a built-in', () => {
  assert.deepEqual(parseCommand('/attach x', skills), { name: 'attach', arg: 'x' });
  assert.equal(suggest('/att', skills).length, 1);
});
t('skills are suggested by prefix', () => {
  assert.deepEqual(suggest('/rev', skills).map((c) => c.name), ['review-pr']);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
