// Exercises the JSONL format and parsing rules the store relies on,
// without needing the vscode API.
const assert = require('node:assert');
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log('  ok   ' + n); pass++; }
                      catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); fail++; } };

const parse = (raw) => {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return out;
};

const meta = { type: 'meta', v: 1, id: 's1', workspace: '/w', created: '2026-09-23T10:00:00.000Z' };
const turns = [
  { type: 'turn', role: 'user', content: 'hello', at: '2026-09-23T10:00:01.000Z', mode: 'chat' },
  { type: 'turn', role: 'assistant', content: 'hi', at: '2026-09-23T10:00:02.000Z', mode: 'chat', promptTokens: 12 },
];
const file = [meta, ...turns].map(r => JSON.stringify(r)).join('\n') + '\n';

t('round trips a full transcript', () => {
  assert.equal(parse(file).length, 3);
  assert.equal(parse(file).filter(r => r.type === 'turn').length, 2);
});

t('a torn final line costs only that turn', () => {
  const torn = file.slice(0, file.length - 12);      // truncate mid-object
  const got = parse(torn);
  assert.ok(got.length >= 2, 'earlier records survived');
  assert.equal(got[0].type, 'meta');
});

t('content with newlines survives', () => {
  const code = { type: 'turn', role: 'assistant', content: 'line1\nline2\n```ts\nconst a=1;\n```', at: 'x', mode: 'chat' };
  const round = parse(JSON.stringify(code) + '\n')[0];
  assert.equal(round.content, code.content);
});

t('sorts newest first by updated', () => {
  const s = [{ updated: '2026-09-20T00:00:00Z' }, { updated: '2026-09-23T00:00:00Z' }, { updated: '2026-09-21T00:00:00Z' }];
  s.sort((a, b) => b.updated.localeCompare(a.updated));
  assert.equal(s[0].updated, '2026-09-23T00:00:00Z');
});

t('session ids are filename-safe and sort chronologically', () => {
  const mk = (iso) => iso.replace(/[:.]/g, '-').replace('Z', '');
  const a = mk('2026-09-23T09-00-00.000Z'.replace(/-/g, ':').replace('T', 'T'));
  const ids = ['2026-09-23T10:00:00.000Z', '2026-09-23T09:00:00.000Z', '2026-09-24T01:00:00.000Z'].map(mk);
  assert.ok(ids.every(i => /^[A-Za-z0-9T_-]+$/.test(i)), 'filename safe: ' + ids.join(','));
  assert.deepEqual([...ids].sort(), [ids[1], ids[0], ids[2]]);
});

t('workspace slug strips separators', () => {
  const slug = '/Users/x/Coding/proj'.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-80);
  assert.equal(slug, 'Users-x-Coding-proj');
  assert.ok(!slug.includes('/'));
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
