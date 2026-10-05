// Which paths the agent's tools will open. A workspace stub records what
// read_file asks for instead of touching the disk.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTool } = require('../out/core/harness/tools');

const opened = [];
const workspace = {
  read: async (file) => { opened.push(file); return 'text of ' + file; },
};

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const ws = '/work/proj';
const notes = path.join(os.homedir(), 'notes');
const ctx = (extraRoots = []) => ({ root: ws, workspace, maxReadChars: 1000, maxSearchLines: 25, extraRoots });
const read = async (p, extra) => { opened.length = 0; const r = await runTool('read_file', { path: p }, ctx(extra)); return { ...r, opened: opened[0] }; };

(async () => {
  console.log('\nread_file inside the workspace');
  await t('relative path', async () => assert.equal((await read('src/a.ts')).opened, '/work/proj/src/a.ts'));
  await t('workspace-rooted path', async () => assert.equal((await read('/src/a.ts')).opened, '/work/proj/src/a.ts'));
  await t('absolute path inside', async () => assert.equal((await read('/work/proj/src/a.ts')).opened, '/work/proj/src/a.ts'));

  // Whatever gets opened must be inside the workspace or a grant. An absolute
  // path outside both is read as workspace-rooted, which is harmless.
  const confined = (r, roots) => {
    if (r.opened === undefined) return;
    const real = path.resolve(r.opened); // what the filesystem would open
    assert.ok(roots.some((d) => real === d || real.startsWith(d + '/')), `opened ${r.opened}`);
  };

  console.log('\nread_file escaping the workspace');
  await t('relative traversal is refused', async () => {
    const r = await read('../../etc/passwd');
    assert.equal(r.ok, false); assert.equal(r.opened, undefined);
    assert.match(r.text, /No extra folders are granted/);
  });
  await t('absolute traversal stays inside', async () => {
    confined(await read('/work/proj/../../etc/passwd'), [ws]);
  });
  await t('a sibling sharing the prefix stays inside', async () => {
    confined(await read('/work/project-secrets/key'), [ws]);
  });
  await t('an ungranted absolute path is read as workspace-rooted', async () => {
    assert.equal((await read('/etc/hosts')).opened, '/work/proj/etc/hosts');
  });

  console.log('\nread_file in a granted folder');
  await t('absolute path inside a grant', async () => {
    assert.equal((await read(notes + '/a.md', [notes])).opened, notes + '/a.md');
  });
  await t('~ expands to the home directory', async () => {
    assert.equal((await read('~/notes/a.md', [notes])).opened, notes + '/a.md');
  });
  await t('traversal out of a grant stays confined', async () => {
    confined(await read(notes + '/../.ssh/id_rsa', [notes]), [ws, notes]);
  });
  await t('the refusal names the grants', async () => {
    assert.match((await read('../../x', [notes])).text, new RegExp(notes.replace(/[/.]/g, '\\$&')));
  });
  await t('relative paths still mean the workspace', async () => {
    assert.equal((await read('a.md', [notes])).opened, '/work/proj/a.md');
  });

  console.log('\nsearch');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-access-'));
  fs.writeFileSync(path.join(tmp, 'n.md'), 'needle here\n');
  await t('searches a granted folder by path', async () => {
    const r = await runTool('search', { pattern: 'needle', path: tmp }, ctx([tmp]));
    assert.equal(r.ok, true, r.text); assert.match(r.text, /n\.md:1:needle here/);
  });
  await t('reading a granted folder lists it', async () => {
    fs.mkdirSync(path.join(tmp, 'sub'));
    const r = await runTool('read_file', { path: tmp }, ctx([tmp]));
    assert.equal(r.ok, true); assert.match(r.text, /is a folder containing:\nn\.md\nsub\/$/);
  });
  await t('does not search a folder that is not granted', async () => {
    const r = await runTool('search', { pattern: 'needle', path: tmp }, ctx());
    assert.doesNotMatch(r.text, /needle here/);
  });
  fs.rmSync(tmp, { recursive: true });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
