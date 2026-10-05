const assert = require('node:assert');
const { parseSkill, splitFrontmatter, expandSkill, renderCatalog } = require('../out/core/harness/skills/skillFormat');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

console.log('\nfrontmatter');
t('reads plain, quoted and commented values', () => {
  const { meta, body } = splitFrontmatter('---\nname: review\ndescription: "Say \\"hi\\""\nargument-hint: \'[pr]\'  # shown in the list\n---\nBody\n');
  assert.deepEqual(meta, { name: 'review', description: 'Say "hi"', 'argument-hint': '[pr]' });
  assert.equal(body, 'Body\n');
});
t('folds a > block and keeps a | block', () => {
  const { meta } = splitFrontmatter('---\ndescription: >\n  one\n  two\n\n  three\nnotes: |\n  a\n  b\n---\n');
  assert.equal(meta.description, 'one two\nthree');
  assert.equal(meta.notes, 'a\nb');
});
t('joins an indented plain continuation', () => {
  assert.equal(splitFrontmatter('---\ndescription: one\n  two\n---\n').meta.description, 'one two');
});
t('skips nested maps instead of misreading them', () => {
  const { meta } = splitFrontmatter('---\nname: x\nmetadata:\n  author: me\n  version: 1\ndescription: d\n---\n');
  assert.deepEqual(meta, { name: 'x', description: 'd' });
});
t('no frontmatter leaves the text as the body', () => {
  assert.deepEqual(splitFrontmatter('# Title\ntext'), { meta: {}, body: '# Title\ntext' });
});

console.log('\nparseSkill');
t('parses a standard SKILL.md', () => {
  const s = parseSkill('---\nname: review-pr\ndescription: Review a PR\nargument-hint: <number>\n---\n\n# Steps\n1. read\n', 'review-pr');
  assert.equal(s.name, 'review-pr');
  assert.equal(s.description, 'Review a PR');
  assert.equal(s.argumentHint, '<number>');
  assert.equal(s.body, '# Steps\n1. read');
  assert.equal(s.userInvocable, true);
  assert.equal(s.modelInvocable, true);
});
t('the folder name stands in for a missing name', () => {
  assert.equal(parseSkill('---\ndescription: d\n---\nx', 'from-dir').name, 'from-dir');
});
t('the first body line stands in for a missing description', () => {
  assert.equal(parseSkill('# Deploy the app\nsteps', 'deploy').description, 'Deploy the app');
});
t('invocation flags', () => {
  const s = parseSkill('---\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\n---\n', 'x');
  assert.equal(s.modelInvocable, false);
  assert.equal(s.userInvocable, false);
});
t('rejects a name that cannot be a command', () => {
  assert.match(parseSkill('---\nname: Review PR\ndescription: d\n---\n', 'x').error, /not a valid skill name/);
});
t('tolerates CRLF and a BOM', () => {
  assert.equal(parseSkill('﻿---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n', 'a').body, 'body');
});

console.log('\nexpandSkill');
const skill = { name: 'fix', body: 'Fix issue $ARGUMENTS, first word $ARGUMENTS[0].', files: ['ref.md'] };
t('substitutes arguments', () => {
  assert.equal(expandSkill(skill, '42 now', false), '<skill name="fix">\nFix issue 42 now, first word 42.\n</skill>');
});
t('appends arguments the body does not place', () => {
  assert.match(expandSkill({ name: 'a', body: 'Do it.', files: [] }, 'x y', false), /\nARGUMENTS: x y$/);
});
t('lists bundled files only when they can be read', () => {
  assert.match(expandSkill(skill, '', true), /readable with load_skill: ref\.md/);
  assert.doesNotMatch(expandSkill(skill, '', false), /load_skill/);
});
t('puts a note after the skill', () => {
  assert.match(expandSkill(skill, '', true, 'Write the file yourself.'), /<\/skill>[\s\S]*Write the file yourself\.$/);
  assert.doesNotMatch(expandSkill(skill, '', true), /yourself/);
});
t('leaves shell positional parameters alone', () => {
  assert.match(expandSkill({ name: 'a', body: "awk '{print $1}'", files: [] }, 'x', false), /\$1/);
});

console.log('\nrenderCatalog');
t('one line per skill, whitespace collapsed', () => {
  const c = renderCatalog([{ name: 'a', description: 'one\ntwo' }]);
  assert.match(c, /\n- a: one two$/);
});
t('empty when there are no skills', () => assert.equal(renderCatalog([]), ''));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
