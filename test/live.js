// The live file a running localaitab keeps at ~/.localaitab/sessions/<pid>.json,
// in the shape of Claude Code's, and `localaitab --resume <id>`. The terminal
// runs for real, piped, against a scripted stand-in for Ollama.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { LiveSession, procStart, tmuxPane } = require('../out/core/harness/live');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}
const noLog = { appendLine() {} };
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAIN = path.join(__dirname, '..', 'out', 'hosts', 'tui', 'main.js');

/** How a session monitor lists start times with ps: every pid, UTC, C locale, spaces squeezed. */
function monitorStart(pid) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,lstart='], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, encoding: 'utf8' });
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.split(/\s+/)[0] === String(pid));
  return line.split(/\s+/).slice(1).join(' ');
}

(async () => {
  console.log('\nthe live file');
  await t('it holds what a monitor reads, and its start time matches ps', () => {
    const dir = tmp('qwen-live-');
    const live = new LiveSession({ entrypoint: 'localaitab-tui', cwd: '/work', sessionId: 's1', dir, log: noLog });
    const f = read(path.join(dir, `${process.pid}.json`));
    assert.equal(f.pid, process.pid);
    assert.equal(f.sessionId, 's1');
    assert.equal(f.cwd, '/work');
    assert.equal(f.kind, 'interactive');
    assert.equal(f.entrypoint, 'localaitab-tui');
    assert.equal(f.status, 'idle');
    assert.equal(typeof f.startedAt, 'number');
    assert.equal(typeof f.updatedAt, 'number');
    assert.match(f.version, /^\d+\.\d+\.\d+/);
    assert.match(f.procStart, /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d \d{4}$/);
    assert.equal(f.procStart.replace(/\s+/g, ' '), monitorStart(process.pid));
    live.close();
    assert.ok(!fs.existsSync(live.file), 'removed on close');
    live.close();
    fs.rmSync(dir, { recursive: true });
  });
  await t('status changes carry their time; the session and its title follow', async () => {
    const dir = tmp('qwen-live-');
    const live = new LiveSession({ entrypoint: 'localaitab-tui', cwd: '/work', sessionId: 's1', dir, log: noLog });
    const first = read(live.file).statusUpdatedAt;
    await sleep(5);
    live.setSession('s1', 'Fix the parser');
    assert.equal(read(live.file).statusUpdatedAt, first, 'not a status change');
    live.setStatus('busy');
    const busy = read(live.file);
    assert.equal(busy.status, 'busy');
    assert.ok(busy.statusUpdatedAt > first);
    assert.equal(busy.name, 'Fix the parser');
    live.setSession('s2');
    assert.equal(read(live.file).sessionId, 's2');
    assert.equal(read(live.file).name, undefined, 'a new session has no title yet');
    live.close();
    fs.rmSync(dir, { recursive: true });
  });
  await t('inside tmux it names the pane; outside, nothing; a tmux that fails says why', () => {
    // A stand-in runner, not a fake tmux on PATH: running a freshly written
    // script waits on the endpoint scanner, which sometimes outlasted the
    // two-second timeout and failed this test for no reason of its own.
    const asked = [];
    const run = (args) => { asked.push(args.join(' ')); return 'main:@3.%7\n'; };
    const logged = [];
    const log = { appendLine: (l) => logged.push(l) };
    const saved = process.env.TMUX_PANE;
    try {
      process.env.TMUX_PANE = '%7';
      assert.equal(tmuxPane({ run }), 'main:@3.%7');
      assert.deepEqual(asked, ['display -p -t %7 #S:#{window_id}.#{pane_id}']);
      const timedOut = () => { throw Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
      assert.equal(tmuxPane({ run: timedOut, log }), undefined);
      assert.deepEqual(logged, ['[live] tmux did not name pane %7: ETIMEDOUT']);
      delete process.env.TMUX_PANE;
      assert.equal(tmuxPane({ run }), undefined);
      assert.equal(asked.length, 1, 'outside tmux, tmux is not asked');
    } finally {
      if (saved === undefined) { delete process.env.TMUX_PANE; } else { process.env.TMUX_PANE = saved; }
    }
  });
  await t('a reader polling while it is rewritten never gets invalid JSON', async () => {
    const dir = tmp('qwen-live-');
    const writer = spawn(process.execPath, ['-e', `
      const { LiveSession } = require(${JSON.stringify(path.join(__dirname, '..', 'out', 'core', 'harness', 'live'))});
      const live = new LiveSession({ entrypoint: 'x', cwd: '/w', sessionId: 's', dir: ${JSON.stringify(dir)}, log: { appendLine() {} } });
      process.stdout.write('ready\\n');
      for (let i = 0; i < 3000; i++) { live.setStatus(i % 2 ? 'busy' : 'idle'); live.setSession('s', 'title '.repeat(i % 50)); }
      live.close();
    `]);
    await new Promise((r) => writer.stdout.once('data', r));
    let reads = 0, bad = 0;
    const done = new Promise((r) => writer.on('exit', r));
    let finished = false;
    done.then(() => { finished = true; });
    while (!finished) {
      let text;
      try { text = fs.readFileSync(path.join(dir, `${writer.pid}.json`), 'utf8'); } catch { await sleep(0); continue; }
      reads++;
      try { JSON.parse(text); } catch { bad++; }
      await sleep(0);
    }
    assert.ok(reads > 20, `read it ${reads} times`);
    assert.equal(bad, 0);
    assert.deepEqual(fs.readdirSync(dir), [], 'no file and no temporary left behind');
    fs.rmSync(dir, { recursive: true });
  });

  console.log('\nthe terminal');
  // Each /api/chat request takes the next scripted reply, after `delay` ms.
  let script = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/show') { res.end(JSON.stringify({ capabilities: ['tools'] })); return; }
      const parsed = JSON.parse(body);
      const next = script.shift() ?? { content: 'done' };
      await sleep(next.delay ?? 0);
      if (parsed.stream) {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.write(JSON.stringify({ message: { role: 'assistant', content: next.content }, done: false }) + '\n');
        res.end(JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 7, eval_count: 3 }) + '\n');
        return;
      }
      res.end(JSON.stringify({ message: { role: 'assistant', content: next.content ?? '', tool_calls: next.calls }, prompt_eval_count: 10, eval_count: 5 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const home = tmp('qwen-home-');
  const ws = tmp('qwen-ws-');
  const env = { ...process.env, LOCALAITAB_HOME: home, TMUX_PANE: '' };
  const start = (args) => spawn(process.execPath, [MAIN, '-e', endpoint, '-C', ws, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  await t('a session creates its file, reports busy, waiting and idle, follows /clear and /resume, and removes it on /quit', async () => {
    const child = start(['--operator']);
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const file = path.join(home, 'sessions', `${child.pid}.json`);
    const until = async (what, test) => {
      for (let i = 0; i < 500; i++) { if (test()) { return; } await sleep(10); }
      throw new Error(`timed out waiting for ${what}; output so far:\n${out}`);
    };
    const current = () => { try { return read(file); } catch { return undefined; } };

    await until('the file', () => current());
    assert.equal(current().status, 'idle');
    assert.equal(current().entrypoint, 'localaitab-tui');
    assert.equal(current().cwd, ws);
    assert.equal(current().tmux, undefined);
    assert.equal(current().procStart.replace(/\s+/g, ' '), monitorStart(child.pid));

    // Watch every status the file shows while one operator turn runs.
    const seen = [];
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const s = current()?.status;
        if (s && s !== seen[seen.length - 1]) { seen.push(s); }
        await sleep(2);
      }
    })();
    script = [
      { delay: 150, calls: [{ function: { name: 'run_command', arguments: { command: 'echo hi' } } }] },
      { delay: 150, content: 'You declined, so nothing ran.' },
    ];
    child.stdin.write('run echo hi\n');
    await until('the approval question', () => /Run echo hi/.test(out));
    await sleep(100);
    child.stdin.write('n\n');
    await until('the answer', () => /nothing ran/.test(out));
    await until('idle again', () => current()?.status === 'idle');
    await sleep(20);
    watching = false;
    await watcher;
    assert.deepEqual(seen, ['idle', 'busy', 'waiting', 'busy', 'idle']);

    const first = current();
    assert.equal(first.name, 'run echo hi', 'titled after its first answer');
    const transcript = path.join(home, 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'), `${first.sessionId}.jsonl`);
    assert.ok(fs.existsSync(transcript), 'sessionId names the transcript');

    child.stdin.write('/clear\n');
    await until('a new session id', () => current()?.sessionId !== first.sessionId);
    assert.equal(current().name, undefined);

    child.stdin.write(`/resume ${first.sessionId}\n`);
    await until('the resumed session', () => current()?.sessionId === first.sessionId);
    assert.equal(current().name, 'run echo hi');

    child.stdin.write('/quit\n');
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(file), 'removed on /quit');
  });

  await t('Ctrl+D on an empty prompt (end of input) removes it too', async () => {
    const child = start([]);
    const file = path.join(home, 'sessions', `${child.pid}.json`);
    for (let i = 0; i < 300 && !fs.existsSync(file); i++) { await sleep(10); }
    assert.ok(fs.existsSync(file));
    child.stdin.end();
    assert.equal(await new Promise((r) => child.on('exit', r)), 0);
    assert.ok(!fs.existsSync(file));
  });

  await t('--resume <id> reopens that session; an unknown id says so and exits non-zero', async () => {
    const folder = path.join(home, 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'));
    const [name] = fs.readdirSync(folder);
    const id = name.replace(/\.jsonl$/, '');
    const before = fs.readFileSync(path.join(folder, name), 'utf8');

    script = [{ content: 'Still here.' }];
    const child = start(['--chat', '--resume', id, 'are you there?']);
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    assert.equal(await new Promise((r) => child.on('exit', r)), 0, out);
    assert.match(out, /resumed/);
    assert.match(out, /run echo hi/, 'the earlier turns are played back');
    const after = fs.readFileSync(path.join(folder, name), 'utf8');
    assert.ok(after.startsWith(before) && after.length > before.length, 'the new turn is appended to that session');
    assert.match(after.slice(before.length), /are you there\?/);
    assert.deepEqual(fs.readdirSync(folder), [name], 'no new session was started');

    const unknown = start(['--resume', 'no-such-session']);
    let err = '';
    unknown.stderr.on('data', (c) => { err += c; });
    assert.equal(await new Promise((r) => unknown.on('exit', r)), 1);
    assert.match(err, /no conversation no-such-session/);
    assert.ok(!fs.existsSync(path.join(home, 'sessions', `${unknown.pid}.json`)));
  });

  server.close();
  fs.rmSync(home, { recursive: true });
  fs.rmSync(ws, { recursive: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
