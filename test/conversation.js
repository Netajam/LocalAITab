// The conversation facade against a scripted stand-in for Ollama: what a turn
// leaves in the thread, how the thread is trimmed, how skills expand, and
// that the host's approve and workspace are what the loops actually use.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Conversation } = require('../out/core/harness/conversation');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// Each /api/chat request takes the next scripted reply; the requests are kept.
let script = [];
const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/show') { res.end(JSON.stringify({ capabilities: ['tools'] })); return; }
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const next = script.shift() ?? { content: 'done' };
    if (parsed.stream) { streamReply(res, next); return; }
    res.end(JSON.stringify({ message: { role: 'assistant', content: next.content ?? '', tool_calls: next.calls }, prompt_eval_count: 10, eval_count: 5 }));
  });
});

const call = (name, args) => ({ function: { name, arguments: args } });

/** A streamed reply: one NDJSON line per chunk, then done; `hang` stops before done, for aborts. */
function streamReply(res, next) {
  res.setHeader('Content-Type', 'application/x-ndjson');
  for (const piece of next.chunks ?? [next.content]) {
    res.write(JSON.stringify({ message: { role: 'assistant', content: piece }, done: false }) + '\n');
  }
  if (next.hang) { return; }
  res.end(JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 7, eval_count: 3 }) + '\n');
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-conv-'));
  fs.writeFileSync(path.join(ws, 'calc.js'), 'return a - b;\n');
  fs.mkdirSync(path.join(ws, 'skills', 'review'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review $ARGUMENTS\n---\nReview $ARGUMENTS carefully.\n');

  const written = {};
  const approvals = [];
  const settings = {
    endpoint, model: 'm', keepAlive: '1m', chatMaxTokens: 100, chatTemperature: 0.3, chatHistoryTurns: 2,
    agentMaxSteps: 4, agentTemperature: 0, agentMaxReadChars: 1000, agentMaxSearchLines: 10,
    operatorMaxSteps: 4, operatorTemperature: 0, operatorMaxOutputChars: 1000, operatorCommandTimeout: 5,
  };
  const host = {
    workspace: {
      read: async (f) => written[f] ?? fs.readFileSync(f, 'utf8'),
      replace: async () => { throw new Error('agent mode must not write'); },
      write: async (f, content) => { written[f] = content; },
    },
    approve: async (command) => { approvals.push(command); return undefined; },
    log: { appendLine: () => {} },
    settings: () => settings,
  };
  const turn = (extra = {}) => ({ root: ws, signal: new AbortController().signal, events: { onStep() {}, onThinking() {} }, ...extra });

  console.log('\nagent turns');
  await t('a staged change is noted in the thread, not written', async () => {
    const c = new Conversation(host);
    script = [
      { calls: [call('insert_change', { path: 'calc.js', search: 'a - b', replace: 'a + b' })] },
      { content: 'Fixed the sign.' },
    ];
    const r = await c.run('agent', 'fix calc', turn());
    assert.equal(r.mode, 'agent');
    assert.equal(r.staged.path, 'calc.js');
    assert.equal(r.staged.at, 7);
    assert.equal(r.note, 'Fixed the sign.\n(staged a change to calc.js for review)');
    assert.deepEqual(c.history.map((m) => m.content), ['fix calc', r.note]);
  });
  await t('earlier turns are handed to the next one', async () => {
    const c = new Conversation(host);
    c.remember('q1', 'a1');
    requests.length = 0;
    script = [{ content: 'a2' }];
    await c.run('agent', 'q2', turn());
    const sent = requests[0].messages.map((m) => m.content);
    assert.deepEqual(sent.slice(1), ['q1', 'a1', 'q2']);
  });
  await t('a run with nothing to show leaves the thread alone', async () => {
    const c = new Conversation(host);
    script = [{ content: '' }];
    const r = await c.run('agent', 'hm', turn());
    assert.equal(r.note, '');
    assert.equal(c.history.length, 0);
  });
  await t('the workspace root is not offered again as an extra folder', async () => {
    const c = new Conversation(host);
    requests.length = 0;
    script = [{ content: 'ok' }];
    await c.run('agent', 'q', turn({ extraRoots: [ws] }));
    assert.doesNotMatch(requests[0].messages[0].content, /also granted/);
  });

  console.log('\noperator turns');
  await t('writes go through the host workspace and are noted', async () => {
    const c = new Conversation(host);
    script = [{ calls: [call('write_file', { path: 'new.txt', content: 'hi' })] }, { content: 'Wrote it.' }];
    const r = await c.run('operator', 'make a file', turn());
    assert.equal(written[path.join(ws, 'new.txt')], 'hi');
    assert.deepEqual(r.changed, ['new.txt']);
    assert.equal(r.note, 'Wrote it.\n(changed new.txt)');
  });
  await t('commands go through the host approve', async () => {
    const c = new Conversation(host);
    script = [{ calls: [call('run_command', { command: 'echo hi' })] }, { content: 'It was declined.' }];
    const r = await c.run('operator', 'say hi', turn());
    assert.deepEqual(approvals, ['echo hi']);
    assert.equal(r.steps[0].ok, false);
    assert.match(r.steps[0].result, /^DECLINED/);
  });

  console.log('\nchat turns');
  await t('streams the answer token by token and keeps it in the thread', async () => {
    const c = new Conversation(host);
    const seen = [];
    script = [{ chunks: ['Hel', 'lo ', 'there'] }];
    const r = await c.chat('hi', { signal: new AbortController().signal, onToken: (d) => seen.push(d) });
    assert.deepEqual(seen, ['Hel', 'lo ', 'there']);
    assert.equal(r.answer, 'Hello there');
    assert.deepEqual([r.promptTokens, r.replyTokens, r.aborted], [7, 3, false]);
    assert.deepEqual(c.history.map((m) => m.content), ['hi', 'Hello there']);
  });
  await t('the attached context rides in the system message, the thread after it', async () => {
    const c = new Conversation(host);
    c.remember('q1', 'a1');
    requests.length = 0;
    script = [{ content: 'ok' }];
    await c.chat('q2', { contextBlock: 'CONTEXT-BLOCK', signal: new AbortController().signal, onToken() {} });
    const sent = requests[0].messages;
    assert.equal(requests[0].stream, true);
    assert.match(sent[0].content, /software engineering assistant[\s\S]*ground your answer in[\s\S]*CONTEXT-BLOCK$/);
    assert.deepEqual(sent.slice(1).map((m) => m.content), ['q1', 'a1', 'q2']);
  });
  await t('with nothing attached, nothing tells it to stay within attached context', async () => {
    const c = new Conversation(host);
    requests.length = 0;
    script = [{ content: 'ok' }];
    await c.chat('what is a thread?', { signal: new AbortController().signal, onToken() {} });
    assert.doesNotMatch(requests[0].messages[0].content, /attached|ground/i);
  });
  await t('stopping keeps what arrived and leaves the thread alone', async () => {
    const c = new Conversation(host);
    const ac = new AbortController();
    script = [{ chunks: ['partial '], hang: true }];
    const r = await c.chat('long one', { signal: ac.signal, onToken: () => ac.abort() });
    assert.equal(r.aborted, true);
    assert.equal(r.answer, 'partial ');
    assert.equal(c.history.length, 0);
  });

  console.log('\nthread');
  await t('keeps only chatHistoryTurns turns', () => {
    const c = new Conversation(host);
    for (const n of [1, 2, 3]) { c.remember(`q${n}`, `a${n}`); }
    assert.deepEqual(c.history.map((m) => m.content), ['q2', 'a2', 'q3', 'a3']);
  });
  await t('resume trims too, and clear empties', () => {
    const c = new Conversation(host);
    c.resume([1, 2, 3, 4, 5, 6].map((n) => ({ role: n % 2 ? 'user' : 'assistant', content: String(n) })));
    assert.deepEqual(c.history.map((m) => m.content), ['3', '4', '5', '6']);
    c.clear();
    assert.equal(c.history.length, 0);
  });

  console.log('\nskills');
  await t('loads from the given paths, relative to the workspace', async () => {
    const c = new Conversation(host);
    assert.deepEqual(await c.loadSkills(['skills'], ws), []);
    assert.deepEqual(c.invocableSkills().map((s) => s.name), ['review']);
  });
  await t('expands per mode', async () => {
    const c = new Conversation(host);
    await c.loadSkills(['skills'], ws);
    assert.match(c.skillPrompt('review', 'calc.js', 'chat'), /Review calc\.js carefully\./);
    assert.doesNotMatch(c.skillPrompt('review', 'x', 'agent'), /write_file/);
    assert.match(c.skillPrompt('review', 'x', 'operator'), /write_file/);
    assert.equal(c.skillPrompt('nope', '', 'agent'), undefined);
  });

  console.log('\nskills.json references');
  const { DEFAULT_SKILL_PATHS } = require('../out/core/harness/skills/skills');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-refs-'));
  const skill = (dir, name, extra = '') => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} things\n${extra}---\nDo ${name}.\n`);
  };
  const proj = path.join(home, 'proj');
  skill(path.join(proj, '.localaitab/skills/own'), 'own');
  skill(path.join(proj, '.localaitab/skills/dup'), 'dup');
  skill(path.join(proj, '.claude/skills/claude-only'), 'claude-only');
  skill(path.join(home, 'elsewhere/tdd'), 'tdd');
  skill(path.join(home, 'elsewhere/review'), 'review');
  skill(path.join(home, 'elsewhere/dup'), 'dup');
  fs.mkdirSync(path.join(home, 'elsewhere/not-a-skill'));
  const refsFile = path.join(proj, '.localaitab/skills.json');
  fs.writeFileSync(refsFile, JSON.stringify({ skills: [
    '../../elsewhere/tdd',
    { path: path.join(home, 'elsewhere/review'), model: false },
    '../../elsewhere/dup',
    '../../elsewhere/not-a-skill',
  ] }));
  const load = async () => { const c = new Conversation(host); const problems = await c.loadSkills(['.localaitab/skills'], proj); return { c, problems }; };

  await t('by default only localaitab folders are read', () => {
    assert.deepEqual(DEFAULT_SKILL_PATHS, ['.localaitab/skills', '~/.localaitab/skills']);
  });
  await t('a referenced skill is loaded from where it lives, a folder not named is not', async () => {
    const { c } = await load();
    const names = c.skills.map((s) => s.name);
    assert.ok(names.includes('tdd') && names.includes('own'));
    assert.ok(!names.includes('claude-only'));
    assert.equal(c.skills.find((s) => s.name === 'tdd').dir, path.join(home, 'elsewhere/tdd'));
  });
  await t('"model": false keeps it off the model\'s list but runnable by hand', async () => {
    const { c } = await load();
    const review = c.skills.find((s) => s.name === 'review');
    assert.equal(review.modelInvocable, false);
    assert.match(c.skillPrompt('review', '', 'agent'), /Do review\./);
  });
  await t('the folder\'s own skill wins over a referenced one of the same name', async () => {
    const { c, problems } = await load();
    assert.equal(c.skills.find((s) => s.name === 'dup').dir, path.join(proj, '.localaitab/skills/dup'));
    assert.ok(problems.some((p) => /elsewhere\/dup: shadowed by/.test(p)));
  });
  await t('a reference with no SKILL.md, and a malformed file, are reported', async () => {
    const { problems } = await load();
    assert.ok(problems.some((p) => /not-a-skill: referenced as a skill, but has no SKILL\.md/.test(p)));
    fs.writeFileSync(refsFile, '{ nope');
    const broken = await load();
    assert.ok(broken.problems.some((p) => p.startsWith(refsFile)));
    assert.deepEqual(broken.c.skills.map((s) => s.name).sort(), ['dup', 'own']);
  });
  fs.rmSync(home, { recursive: true });

  server.close();
  fs.rmSync(ws, { recursive: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
