// Transcripts in Claude Code's shape: where they go, what each line holds,
// that they are only ever appended to, and the conversion of older sessions.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SessionStore, projectFolder, gitBranch, convertSessions, turnsOf } = require('../out/core/harness/sessions');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}
const noLog = { appendLine() {} };
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const quiet = { onStep() {}, onThinking() {} };

/**
 * What a session monitor takes from a transcript:
 * the latest ai-title, the first typed prompt, the latest branch, tokens per
 * message id and tools per call id.
 */
function monitorSummary(file) {
  const s = { title: undefined, goal: undefined, branch: undefined, tokens: { input: 0, output: 0 }, tools: {} };
  const usage = new Map();
  const calls = new Set();
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) { continue; }
    const line = JSON.parse(raw);
    if (typeof line.gitBranch === 'string') { s.branch = line.gitBranch; }
    if (line.type === 'ai-title') { s.title = line.aiTitle; }
    if (line.type === 'user' && !s.goal && line.origin?.kind === 'human' && !line.isMeta && !line.toolUseResult) {
      s.goal = line.message.content.trim();
    }
    if (line.type === 'assistant') {
      if (line.message.id && line.message.usage) { usage.set(line.message.id, line.message.usage); }
      for (const b of line.message.content ?? []) {
        if (b.type !== 'tool_use' || calls.has(b.id)) { continue; }
        calls.add(b.id);
        s.tools[b.name] = (s.tools[b.name] ?? 0) + 1;
      }
    }
  }
  for (const u of usage.values()) { s.tokens.input += u.input_tokens ?? 0; s.tokens.output += u.output_tokens ?? 0; }
  return s;
}

(async () => {
  console.log('\nwhere transcripts go');
  await t('the folder is the cwd with every character but ASCII letters and digits as -', () => {
    // The same case Claude Code files its own sessions under.
    assert.equal(projectFolder('/Users/x/My_Repo.v2'), '-Users-x-My-Repo-v2');
    assert.equal(projectFolder('/a//b c'), '-a--b-c', 'nothing collapsed');
    assert.equal(projectFolder('/é/😀'), '----', 'one dash per character, not per UTF-16 unit');
  });
  await t('a session is a UUID, in <base>/<folder>/<id>.jsonl', async () => {
    const base = tmp('qwen-projects-');
    const store = new SessionStore(base, () => '/work/my_repo', noLog);
    assert.match(store.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await store.prompt({ content: 'hi', mode: 'chat', model: 'm' });
    assert.ok(fs.existsSync(path.join(base, '-work-my-repo', `${store.sessionId}.jsonl`)));
    fs.rmSync(base, { recursive: true });
  });
  await t('the branch is read from the repository holding the workspace', async () => {
    const repo = tmp('qwen-git-');
    execFileSync('git', ['init', '-q', '-b', 'rename-parser', repo]);
    fs.mkdirSync(path.join(repo, 'sub'));
    assert.equal(await gitBranch(path.join(repo, 'sub')), 'rename-parser');
    assert.equal(await gitBranch(os.tmpdir()), undefined);
    fs.rmSync(repo, { recursive: true });
  });

  console.log('\nwhat a turn writes');
  const base = tmp('qwen-projects-');
  const repo = tmp('qwen-ws-');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const store = new SessionStore(base, () => repo, noLog);
  const file = () => path.join(base, projectFolder(repo), `${store.sessionId}.jsonl`);
  const sizes = [];
  const contents = [];
  const snapshot = async () => { await store.flushed(); sizes.push(fs.statSync(file()).size); contents.push(fs.readFileSync(file(), 'utf8')); };

  await t('a typed prompt is human; a chat answer carries its id and usage', async () => {
    await store.prompt({ content: 'What does the parser do?', mode: 'chat', model: 'qwen', sources: ['src/p.ts'], contextChars: 40 });
    await snapshot();
    await store.answer({ content: 'It parses.', mode: 'chat', model: 'qwen', promptTokens: 120, replyTokens: 8, ms: 900 });
    await snapshot();
    const [user, reply, title] = lines(file());
    assert.equal(user.type, 'user');
    assert.deepEqual(user.origin, { kind: 'human' });
    assert.equal(user.message.content, 'What does the parser do?');
    assert.equal(user.gitBranch, 'main');
    assert.equal(user.cwd, repo);
    assert.equal(user.sessionId, store.sessionId);
    assert.deepEqual(user.sources, ['src/p.ts']);
    assert.equal(user.parentUuid, null);
    assert.equal(reply.parentUuid, user.uuid);
    assert.match(reply.message.id, /^msg_/);
    assert.deepEqual(reply.message.usage, { input_tokens: 120, output_tokens: 8 });
    assert.deepEqual(reply.message.content, [{ type: 'text', text: 'It parses.' }]);
    assert.equal(reply.mode, 'chat');
    assert.equal(reply.ms, 900);
    assert.deepEqual(title, { type: 'ai-title', aiTitle: 'What does the parser do?', sessionId: store.sessionId });
  });

  await t('an agent turn that reads a file and stages an edit records both calls and both results', async () => {
    const before = lines(file()).length;
    await store.prompt({ content: 'Rename parse to parseAll', mode: 'agent', model: 'qwen' });
    await snapshot();
    const events = store.record(quiet);
    events.onReply({ content: '', toolCalls: [{ function: { name: 'read_file', arguments: { path: 'src/p.ts' } } }], promptTokens: 300, replyTokens: 20 });
    events.onStep({ index: 1, tool: 'read_file', args: { path: 'src/p.ts' }, result: 'export function parse() {}', ok: true, ms: 3 });
    events.onReply({ content: 'Found it.', toolCalls: [{ id: 'call_x', function: { name: 'insert_change', arguments: { path: 'src/p.ts', search: 'parse', replace: 'parseAll' } } }], promptTokens: 350, replyTokens: 30 });
    events.onStep({ index: 2, tool: 'insert_change', args: {}, result: 'OK: staged', ok: true, ms: 1 });
    events.onReply({ content: 'Renamed it.', toolCalls: [], promptTokens: 400, replyTokens: 10 });
    await snapshot();
    await store.answer({ content: 'Renamed it.\n(staged a change to src/p.ts for review)', mode: 'agent', model: 'qwen', promptTokens: 400, replyTokens: 60, steps: 2, staged: 'src/p.ts' });
    await snapshot();

    const turn = lines(file()).slice(before);
    const uses = turn.filter((l) => l.type === 'assistant').flatMap((l) => l.message.content).filter((b) => b.type === 'tool_use');
    const results = turn.filter((l) => l.toolUseResult);
    assert.deepEqual(uses.map((u) => u.name), ['read_file', 'insert_change']);
    assert.deepEqual(uses[0].input, { path: 'src/p.ts' });
    assert.equal(uses[1].id, 'call_x', 'an id Ollama gave is kept');
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.message.content[0].tool_use_id), uses.map((u) => u.id));
    assert.equal(results[0].message.content[0].content, 'export function parse() {}');
    assert.deepEqual(results[0].toolUseResult, { tool: 'read_file', ok: true, ms: 3 });
    assert.ok(!results[0].origin, 'a tool result is not typed by a person');
    const end = turn[turn.length - 1];
    assert.equal(end.turnEnd, true);
    assert.equal(end.staged, 'src/p.ts');
    assert.deepEqual(end.message.usage, { input_tokens: 400, output_tokens: 10 }, 'the answer line carries the final reply\'s usage only');
    assert.equal(turn.filter((l) => l.type === 'ai-title').length, 0, 'titled once');
    for (let i = 1; i < turn.length; i++) { assert.equal(turn[i].parentUuid, turn[i - 1].uuid); }
  });

  await t('an operator turn records the command, and a declined one as declined', async () => {
    const before = lines(file()).length;
    await store.prompt({ content: 'Run the tests', mode: 'operator', model: 'qwen' });
    const events = store.record(quiet);
    events.onReply({ content: '', toolCalls: [{ function: { name: 'run_command', arguments: { command: 'npm test' } } }], promptTokens: 200, replyTokens: 15 });
    events.onStep({ index: 1, tool: 'run_command', args: { command: 'npm test' }, result: 'DECLINED: the user did not allow this command.', ok: false, ms: 2000 });
    events.onReply({ content: 'You declined.', toolCalls: [], promptTokens: 220, replyTokens: 5 });
    await store.answer({ content: 'You declined.', mode: 'operator', model: 'qwen', promptTokens: 220, replyTokens: 20, steps: 1 });
    await snapshot();
    const turn = lines(file()).slice(before);
    const use = turn.find((l) => l.type === 'assistant').message.content.find((b) => b.type === 'tool_use');
    assert.deepEqual(use.input, { command: 'npm test' });
    const result = turn.find((l) => l.toolUseResult).message.content[0];
    assert.equal(result.tool_use_id, use.id);
    assert.equal(result.is_error, true);
    assert.match(result.content, /^DECLINED/);
  });

  await t('a /skill keeps what was typed, sends the expansion, and is not a typed prompt', async () => {
    const before = lines(file()).length;
    await store.prompt({ content: 'Review this change carefully: 42', display: '/review 42', mode: 'chat', model: 'qwen' });
    await store.answer({ content: 'Fine.', mode: 'chat', model: 'qwen', promptTokens: 1, replyTokens: 1 });
    await snapshot();
    const [user] = lines(file()).slice(before);
    assert.equal(user.display, '/review 42');
    assert.equal(user.message.content, 'Review this change carefully: 42');
    assert.equal(user.origin, undefined);
  });

  await t('a stopped turn leaves its question on disk but not in the replay', async () => {
    await store.prompt({ content: 'never answered', mode: 'agent', model: 'qwen' });
    await snapshot();
    const replay = turnsOf(lines(file()));
    assert.ok(!replay.some((r) => r.content === 'never answered'));
    assert.equal(replay.length, 8);
  });

  await t('the file only grows: every write keeps what was there', () => {
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i] > sizes[i - 1], `write ${i} grew the file`);
      assert.ok(contents[i].startsWith(contents[i - 1]), `write ${i} appended`);
    }
  });

  await t('a monitor reads the title, the goal, the branch, the tokens and the tools', () => {
    const s = monitorSummary(file());
    assert.equal(s.title, 'What does the parser do?');
    assert.equal(s.goal, 'What does the parser do?');
    assert.equal(s.branch, 'main');
    assert.deepEqual(s.tools, { insert_change: 1, read_file: 1, run_command: 1 });
    // chat 120+8, agent 300+20, 350+30, 400+10, operator 200+15, 220+5, skill 1+1
    assert.deepEqual(s.tokens, { input: 120 + 300 + 350 + 400 + 200 + 220 + 1, output: 8 + 20 + 30 + 10 + 15 + 5 + 1 });
  });

  await t('resuming lists and replays the session, and new turns follow its last line', async () => {
    const id = store.sessionId;
    const last = lines(file()).filter((l) => l.uuid).pop().uuid;
    const other = new SessionStore(base, () => repo, noLog);
    const [summary] = await other.list();
    assert.equal(summary.id, id);
    assert.equal(summary.title, 'What does the parser do?');
    assert.equal(summary.turns, 4);
    const turns = await other.resume(id);
    assert.deepEqual(turns.map((r) => r.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    assert.equal(turns[3].content, 'Renamed it.\n(staged a change to src/p.ts for review)');
    assert.equal(turns[3].steps, 2);
    assert.equal(turns[6].display, '/review 42');
    await other.prompt({ content: 'and again', mode: 'chat', model: 'qwen' });
    const added = lines(file()).pop();
    assert.equal(added.parentUuid, last);
    assert.equal(lines(file()).filter((l) => l.type === 'ai-title').length, 1, 'a titled session is not titled again');
  });

  await t('the session id is reported as it changes, and the title once there is one', async () => {
    const seen = [];
    const s = new SessionStore(base, () => repo, noLog);
    s.onChange((id, title) => seen.push([id, title]));
    s.startNew();
    const fresh = s.sessionId;
    await s.prompt({ content: 'Title me', mode: 'chat', model: 'q' });
    await s.answer({ content: 'ok', mode: 'chat', model: 'q' });
    await s.resume(store.sessionId);
    assert.deepEqual(seen, [[fresh, undefined], [fresh, 'Title me'], [store.sessionId, 'What does the parser do?']]);
  });
  fs.rmSync(base, { recursive: true });
  fs.rmSync(repo, { recursive: true });

  console.log('\nconverting older sessions');
  await t('old sessions convert once, lose no turn, keep their titles, and never overwrite', async () => {
    const old = tmp('qwen-old-');
    const projects = tmp('qwen-new-');
    const ws = '/Users/me/My_Repo.v2';
    const oldFolder = path.join(old, 'Users-me-My-Repo-v2');
    fs.mkdirSync(oldFolder);
    const meta = (id) => ({ type: 'meta', v: 1, id, workspace: ws, created: '2026-09-28T10:00:00.000Z' });
    const turn = (role, content, at, extra = {}) => ({ type: 'turn', role, content, at, mode: 'agent', model: 'qwen', ...extra });
    const write = (name, records) => fs.writeFileSync(path.join(oldFolder, name), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    write('2026-09-28T10-00-00-000.jsonl', [
      meta('2026-09-28T10-00-00-000'),
      turn('user', 'expanded skill', '2026-09-28T10:00:01.000Z', { display: '/review 42', sources: ['a.ts'] }),
      turn('assistant', 'looks fine', '2026-09-28T10:00:05.000Z', { promptTokens: 50, replyTokens: 7, steps: 3 }),
      turn('user', 'and the tests?', '2026-09-28T10:01:00.000Z'),
      turn('assistant', 'they pass', '2026-09-28T10:01:09.000Z', { promptTokens: 60, replyTokens: 4 }),
    ]);
    write('empty.jsonl', [meta('empty')]);
    fs.writeFileSync(path.join(oldFolder, 'broken.jsonl'), '{"type":"turn","role":"user","content":"no meta","at":"x","mode":"chat"}\n');

    const logged = [];
    assert.equal(await convertSessions(old, projects, { appendLine: (l) => logged.push(l) }), 1);
    const folder = path.join(projects, '-Users-me-My-Repo-v2');
    const [name] = fs.readdirSync(folder);
    assert.match(name, /^[0-9a-f-]{36}\.jsonl$/);
    const converted = path.join(folder, name);
    assert.equal(fs.statSync(converted).mtime.toISOString(), '2026-09-28T10:01:09.000Z', 'dated by its last turn');

    const store = new SessionStore(projects, () => ws, noLog);
    const [summary] = await store.list();
    assert.equal(summary.title, '/review 42', 'the same title as before');
    assert.equal(summary.turns, 2);
    const turns = await store.resume(summary.id);
    assert.deepEqual(turns.map((r) => [r.role, r.content]), [
      ['user', 'expanded skill'], ['assistant', 'looks fine'], ['user', 'and the tests?'], ['assistant', 'they pass'],
    ]);
    assert.equal(turns[0].display, '/review 42');
    assert.deepEqual(turns[0].sources, ['a.ts']);
    assert.equal(turns[1].steps, 3);
    assert.equal(turns[1].at, '2026-09-28T10:00:05.000Z');
    const s = monitorSummary(converted);
    assert.equal(s.goal, 'and the tests?', 'a /skill is not a typed goal');
    assert.deepEqual(s.tokens, { input: 110, output: 11 });

    assert.ok(!fs.existsSync(path.join(oldFolder, 'empty.jsonl')), 'a session with no turns is dropped');
    assert.ok(fs.existsSync(path.join(oldFolder, 'broken.jsonl')), 'one that cannot be converted stays');
    assert.match(logged.join('\n'), /broken\.jsonl: no workspace recorded/);

    const again = fs.readFileSync(converted, 'utf8');
    assert.equal(await convertSessions(old, projects, noLog), 0, 'a second run converts nothing');
    assert.equal(fs.readFileSync(converted, 'utf8'), again);

    // Cut short after writing, before removing the source: the rerun finds its own file.
    fs.rmSync(path.join(oldFolder, 'broken.jsonl'));
    write('2026-09-28T10-00-00-000.jsonl', [meta('2026-09-28T10-00-00-000'), turn('user', 'q', 'x'), turn('assistant', 'a', 'x')]);
    assert.equal(await convertSessions(old, projects, noLog), 0);
    assert.equal(fs.readFileSync(converted, 'utf8'), again, 'never over an existing file');
    assert.equal(fs.readdirSync(folder).length, 1);

    fs.rmSync(path.join(oldFolder, '2026-09-28T10-00-00-000.jsonl'));
    await convertSessions(old, projects, noLog);
    assert.ok(!fs.existsSync(oldFolder), 'an emptied folder is removed');
    assert.ok(fs.existsSync(old), 'the sessions folder itself stays, for the live files');
    fs.rmSync(old, { recursive: true });
    fs.rmSync(projects, { recursive: true });
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
