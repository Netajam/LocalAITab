// Which paths resolveInWorkspace lets through. Every tool that writes relies on
// it, operator mode's unapproved write_file and edit_file included.
const assert = require('node:assert');
const path = require('node:path');
const { resolveInWorkspace } = require('../out/core/harness/tools');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const at = (p) => resolveInWorkspace(p, '/ws/proj');

console.log('\nresolveInWorkspace');
t('relative paths land in the workspace', () => {
  assert.equal(at('src/a.ts'), '/ws/proj/src/a.ts');
});
t('workspace-rooted paths land in the workspace', () => {
  assert.equal(at('/src/a.ts'), '/ws/proj/src/a.ts');
});
t('absolute paths inside the workspace are kept', () => {
  assert.equal(at('/ws/proj/src/a.ts'), '/ws/proj/src/a.ts');
});
// An absolute path outside the workspace is read as rooted at it instead, so
// the property that matters is where the answer lands, never outside.
const inside = (p) => {
  const r = at(p);
  // Normalised before comparing: "/ws/proj/../../etc" also starts with "/ws/proj/".
  const real = r === undefined ? r : path.posix.normalize(r);
  assert.ok(real === undefined || real === '/ws/proj' || real.startsWith('/ws/proj/'), `${p} resolved to ${r}`);
  return r;
};
t('absolute paths outside the workspace do not leave it', () => {
  assert.equal(inside('/etc/passwd'), '/ws/proj/etc/passwd');
});
t('an absolute path cannot climb out through ".."', () => {
  inside('/ws/proj/../../etc/passwd');
  inside('/ws/proj/src/../../proj2/x');
  inside('/ws/proj/..');
});
t('".." that stays inside the workspace is allowed', () => {
  assert.equal(at('/ws/proj/src/../lib/b.ts'), '/ws/proj/lib/b.ts');
});
t('a sibling folder sharing the prefix does not match', () => {
  inside('/ws/project-other/x');
});
t('an empty path is refused', () => {
  assert.equal(at('  '), undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
