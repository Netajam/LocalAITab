// The terminal's pure parts: fuzzy ranking, @mentions to context, markdown,
// and the live area's layout. Run without a terminal, so without colour.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rank, score, indexPaths } = require('../out/hosts/tui/terminal/finder');
const { mentions, mentionOf, collect } = require('../out/hosts/tui/context');
const { renderMarkdown, inline } = require('../out/hosts/tui/markdown');
const { layout, wrapInput, shortcuts } = require('../out/hosts/tui/terminal/layout');
const { visibleWidth, wrap, truncate } = require('../out/hosts/tui/render');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}
const entries = (paths) => paths.map((p) => ({ path: p, dir: p.endsWith('/') }));

(async () => {
  console.log('\nfinder');
  const tree = entries(['src/', 'src/core/', 'src/core/conversation.ts', 'src/hosts/tui/session.ts', 'test/conversation.js', 'README.md', 'src/core/llm/ollama.ts']);
  await t('matches in order, case-insensitively', () => {
    assert.ok(score('cnv', 'src/core/conversation.ts'));
    assert.equal(score('xyz', 'src/core/conversation.ts'), undefined);
    assert.equal(score('vnc', 'conv'), undefined);
  });
  await t('a capital makes it case-sensitive', () => {
    assert.ok(score('READ', 'README.md'));
    assert.equal(score('Read', 'README.md'), undefined);
  });
  await t('a whole segment beats scattered letters', () => {
    assert.equal(rank('core', tree, 1)[0].entry.path, 'src/core/');
  });
  await t('the file name counts more than the folders', () => {
    assert.equal(rank('session', tree, 1)[0].entry.path, 'src/hosts/tui/session.ts');
  });
  await t('positions point at the matched characters', () => {
    const m = rank('ollama', tree, 1)[0];
    assert.equal(m.positions.map((i) => m.entry.path[i]).join(''), 'ollama');
  });
  await t('an empty query lists the top level', () => {
    assert.deepEqual(rank('', tree, 10).map((m) => m.entry.path), ['src/', 'README.md']);
  });
  await t('indexes files and their folders, hidden ones last, honouring .gitignore but not .git', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-finder-'));
    fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skip'));
    fs.mkdirSync(path.join(dir, '.config'));
    fs.writeFileSync(path.join(dir, 'a/b/c.ts'), '');
    fs.writeFileSync(path.join(dir, 'skip/x.ts'), '');
    fs.writeFileSync(path.join(dir, '.config/app.json'), '');
    fs.writeFileSync(path.join(dir, '.env.example'), '');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'skip/\n');
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: dir });
    const paths = (await indexPaths(dir)).map((e) => e.path);
    fs.rmSync(dir, { recursive: true });
    assert.deepEqual(paths, ['a/', 'a/b/', '.config/', 'a/b/c.ts', '.config/app.json', '.env.example', '.gitignore']);
  });
  await t('a hidden file is found by name', () => {
    const hidden = entries(['src/a.ts', '.github/workflows/ci.yml', '.env.example']);
    assert.equal(rank('ci', hidden, 1)[0].entry.path, '.github/workflows/ci.yml');
    assert.equal(rank('.env', hidden, 1)[0].entry.path, '.env.example');
  });

  console.log('\n@mentions');
  await t('finds mentions at the start and after spaces, not in emails', () => {
    assert.deepEqual(mentions('@a.ts look at @src/ and me@x.com'), ['a.ts', 'src/']);
  });
  await t('quotes a path with a space, and reads it back', () => {
    assert.equal(mentionOf('my notes/a.md'), '@"my notes/a.md"');
    assert.deepEqual(mentions('see @"my notes/a.md" please'), ['my notes/a.md']);
  });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ctx-'));
  fs.mkdirSync(path.join(ws, 'lib/node_modules/dep'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.ts'), 'const a = 1;\n');
  fs.writeFileSync(path.join(ws, 'lib/b.py'), 'b = 2\n');
  fs.mkdirSync(path.join(ws, 'lib/.hooks'));
  fs.writeFileSync(path.join(ws, 'lib/.hooks/pre.sh'), 'echo hi\n');
  fs.writeFileSync(path.join(ws, 'lib/logo.png'), Buffer.from([0x89, 0x50, 0, 1]));
  fs.writeFileSync(path.join(ws, 'lib/node_modules/dep/i.js'), 'x');
  fs.writeFileSync(path.join(ws, 'big.txt'), 'x'.repeat(500));
  await t('a file is attached whole, in a fenced block with its language', async () => {
    const c = await collect('fix @a.ts', ws, 1000);
    assert.match(c.block, /--- Attached file: a\.ts ---\n```typescript\nconst a = 1;/);
    assert.deepEqual(c.attached, [{ path: 'a.ts', files: 1, chars: 13 }]);
  });
  await t('a folder attaches its source files, not binaries or dependencies', async () => {
    const c = await collect('@lib', ws, 1000);
    assert.match(c.block, /Attached file: lib\/b\.py/);
    assert.match(c.block, /Attached file: lib\/\.hooks\/pre\.sh/);
    assert.doesNotMatch(c.block, /logo|node_modules/);
  });
  await t('the budget cuts a file short and leaves the rest out', async () => {
    const c = await collect('@big.txt @a.ts', ws, 100);
    assert.match(c.block, /cut at the context budget/);
    assert.deepEqual(c.skipped, ['a.ts (over the context budget)']);
  });
  await t('a missing path is reported, not fatal', async () => {
    const c = await collect('@nope.ts', ws, 100);
    assert.equal(c.block, '');
    assert.deepEqual(c.skipped, ['nope.ts (not found)']);
  });
  fs.rmSync(ws, { recursive: true });

  console.log('\nmarkdown');
  await t('inline code, links and emphasis', () => {
    assert.equal(inline('use `a_b*c*` and **bold** and *it*'), 'use a_b*c* and bold and it');
    assert.equal(inline('[docs](https://x.dev/a_b)'), 'docs (https://x.dev/a_b)');
  });
  await t('lists wrap under their text', () => {
    assert.equal(renderMarkdown('- one two three four', 12), '• one two\n  three four');
    assert.equal(renderMarkdown('1. alpha beta gamma', 13), '1. alpha beta\n   gamma');
  });
  await t('code blocks are boxed and keep their content', () => {
    const out = renderMarkdown('```js\nconst x = "a";\n```', 40).split('\n');
    assert.match(out[0], /^╭─ js ─+$/);
    assert.equal(out[1], '│ const x = "a";');
    assert.equal(out[2], '╰─');
  });
  await t('a comment marker inside a string is not a comment', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete require.cache[require.resolve('../out/hosts/tui/render')];
    delete require.cache[require.resolve('../out/hosts/tui/markdown')];
    const coloured = require('../out/hosts/tui/markdown').renderMarkdown('```py\nx = "a#b"  # note\n```', 40);
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    assert.match(coloured, /\x1b\[32m"a#b"\x1b\[39m  \x1b\[2m# note/);
  });
  await t('tables line up, numbers to the right when asked', () => {
    const out = renderMarkdown('| a | n |\n|---|--:|\n| xx | 5 |', 40).split('\n');
    assert.deepEqual(out, ['┌─────┬─────┐', '│ a   │   n │', '├─────┼─────┤', '│ xx  │   5 │', '└─────┴─────┘']);
  });
  await t('headings, quotes, rules and blank runs', () => {
    assert.equal(renderMarkdown('# Title\n\n\n\n> quoted\n\n---', 30), 'Title\n\n│ quoted\n\n' + '─'.repeat(30));
  });

  console.log('\nlayout');
  await t('width counts wide characters twice and escape codes not at all', () => {
    assert.equal(visibleWidth('\x1b[1mab\x1b[22m'), 2);
    assert.equal(visibleWidth('日本'), 4);
  });
  await t('wrap and truncate', () => {
    assert.deepEqual(wrap('aa bb cc', 5, '  '), ['aa bb', '  cc']);
    assert.equal(truncate('abcdef', 4), 'abc…');
  });
  await t('input wraps under the prompt and tracks the cursor', () => {
    const w = wrapInput('> ', 'abcdefgh', 5, 6);
    assert.deepEqual(w.rows, ['> abcd', '  efgh']);
    assert.deepEqual([w.cursorRow, w.cursorCol], [1, 3]);
  });
  await t('newlines start new rows', () => {
    const w = wrapInput('> ', 'ab\ncd', 5, 20);
    assert.deepEqual(w.rows, ['> ab', '  cd']);
    assert.deepEqual([w.cursorRow, w.cursorCol], [1, 4]);
  });
  await t('shortcuts wrap between items, never inside one', () => {
    const rows = shortcuts([['⏎', 'send'], ['⌥⏎', 'newline'], ['@', 'attach']], 24);
    assert.deepEqual(rows, [' ⏎ send  ·  ⌥⏎ newline', ' @ attach']);
  });
  await t('the live area: rule, input, popup, footer, cursor on the input', () => {
    const laid = layout({
      width: 40, height: 20, footer: ['footer'],
      input: { prompt: '> ', text: 'hi', cursor: 2 },
      popup: { items: [{ label: 'a.ts' }, { label: 'b.ts' }], selected: 1 },
    });
    assert.deepEqual(laid.rows, ['─'.repeat(39), '> hi', '  a.ts', '❯ b.ts', 'footer']);
    assert.deepEqual(laid.cursor, { row: 1, col: 4 });
  });
  await t('a tall draft scrolls to keep the cursor in view', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const laid = layout({ width: 40, height: 8, footer: ['f'], input: { prompt: '> ', text, cursor: text.length } });
    assert.ok(laid.rows.length <= 8);
    assert.equal(laid.rows[laid.cursor.row].trim(), 'line 29');
  });

  console.log('\noptions');
  const { parseArgs } = require('../out/hosts/tui/options');
  await t('flags, values and the task', () => {
    const r = parseArgs(['-C', 'sub', '--operator', '--allow', '~/notes', '-m', 'foo', 'fix', 'it'], '/w');
    assert.equal(r.options.root, '/w/sub');
    assert.equal(r.options.mode, 'operator');
    assert.equal(r.options.model, 'foo');
    assert.deepEqual(r.options.extraRoots, [path.join(os.homedir(), 'notes')]);
    assert.equal(r.task, 'fix it');
  });
  await t('--chat starts in chat mode; agent is the default', () => {
    assert.equal(parseArgs(['--chat'], '/w').options.mode, 'chat');
    assert.equal(parseArgs([], '/w').options.mode, 'agent');
  });
  await t('help, an unknown flag, a missing value', () => {
    assert.deepEqual(parseArgs(['fix', '--help'], '/w'), { help: true });
    assert.deepEqual(parseArgs(['--bogus'], '/w'), { error: 'unknown option --bogus' });
    assert.deepEqual(parseArgs(['-m'], '/w'), { error: '-m needs a value' });
  });

  console.log('\nsaved conversations');
  const { Transcript, ago, answeredBy } = require('../out/hosts/tui/transcript');
  const saved = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-sessions-'));
  const noLog = { appendLine() {} };
  const asked = (question, extra = {}) => ({ question, display: question, mode: 'chat', model: 'm', sources: [], contextChars: 0, ...extra });
  await t('turns are saved, listed newest first, and reopened', async () => {
    const tr = new Transcript(saved, '/work/a', noLog);
    await tr.save(asked('first question'), { content: 'first answer' });
    const firstId = tr.current;
    tr.startOver();
    await new Promise((r) => setTimeout(r, 5));
    await tr.save(asked('expanded skill text', { display: '/review 42', sources: ['src/a.ts'], contextChars: 120 }), { content: 'looks fine', steps: 2 });
    const list = await tr.choices();
    assert.deepEqual(list.map((c) => c.label), ['/review 42', 'first question']);
    assert.match(list[0].hint, /^just now · 1 turn · current$/);
    const turns = await tr.open(firstId);
    assert.deepEqual(turns.map((t) => [t.role, t.content]), [['user', 'first question'], ['assistant', 'first answer']]);
    assert.equal(tr.current, firstId);
  });
  await t('what was typed and attached is kept apart from what was sent', async () => {
    const tr = new Transcript(saved, '/work/a', noLog);
    const id = (await tr.choices())[0].value;
    const [user, reply] = await tr.open(id);
    assert.equal(user.content, 'expanded skill text');
    assert.equal(user.display, '/review 42');
    assert.deepEqual(user.sources, ['src/a.ts']);
    assert.equal(reply.steps, 2);
  });
  await t('each workspace has its own list, and starting over writes nothing until a turn', async () => {
    const other = new Transcript(saved, '/work/b', noLog);
    assert.deepEqual(await other.choices(), []);
    other.startOver();
    assert.deepEqual(await other.choices(), []);
  });
  await t('a run is saved by its note, with its steps and staged file; one with no note is not', () => {
    const run = { mode: 'agent', note: 'Fixed it.\n(staged a change to a.ts for review)', promptTokens: 9, replyTokens: 4, totalMs: 50, steps: [1, 2], staged: { path: 'a.ts' } };
    assert.deepEqual(answeredBy(run), { content: run.note, promptTokens: 9, replyTokens: 4, ms: 50, steps: 2, staged: 'a.ts' });
    assert.equal(answeredBy({ ...run, note: '' }), undefined);
  });
  await t('times read as people say them', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    assert.equal(ago('2026-09-29T11:59:40Z', now), 'just now');
    assert.equal(ago('2026-09-29T11:15:00Z', now), '45 min ago');
    assert.equal(ago('2026-09-29T07:00:00Z', now), '5 h ago');
    assert.equal(ago('2026-09-28T09:00:00Z', now), 'yesterday');
    assert.equal(ago('2026-09-20T09:00:00Z', now), '2026-09-20');
  });
  await t('--continue and -c ask to reopen the latest', () => {
    assert.equal(parseArgs(['-c'], '/w').options.continue, true);
    assert.equal(parseArgs(['--continue'], '/w').options.continue, true);
    assert.equal(parseArgs([], '/w').options.continue, false);
  });
  await t('a session with no finished turn is not listed', async () => {
    const dir = path.join(saved, '-work-a');
    const line = { type: 'user', sessionId: 'stopped', origin: { kind: 'human' }, message: { role: 'user', content: 'stopped before an answer' } };
    fs.writeFileSync(path.join(dir, 'stopped.jsonl'), JSON.stringify(line) + '\n');
    const tr = new Transcript(saved, '/work/a', noLog);
    assert.ok(!(await tr.choices()).some((c) => c.value === 'stopped'));
  });
  await t('every host keeps transcripts in one folder, ~/.localaitab/projects unless moved', () => {
    const { PROJECTS_DIR } = require('../out/core/harness/sessions');
    assert.equal(PROJECTS_DIR, path.join(process.env.LOCALAITAB_HOME || path.join(os.homedir(), '.localaitab'), 'projects'));
    assert.equal(parseArgs([], '/w').options.projectsDir, PROJECTS_DIR);
  });
  fs.rmSync(saved, { recursive: true });

  console.log('\nfull screen');
  const { takeMouse } = require('../out/hosts/tui/terminal/window/input');
  const { hardWrap } = require('../out/hosts/tui/render');
  const wheel = (d) => ({ kind: 'wheel', direction: d });
  await t('wheel turns and left clicks come out of the key stream; the rest is dropped', () => {
    assert.deepEqual(takeMouse('a\x1b[<64;10;5Mb\x1b[<65;10;5M'), { rest: 'ab', mouse: [wheel(1), wheel(-1)], pending: '' });
    assert.deepEqual(takeMouse('\x1b[<0;3;4M\x1b[<0;3;4mx'), { rest: 'x', mouse: [{ kind: 'click', col: 3, row: 4 }], pending: '' });
    assert.deepEqual(takeMouse('\x1b[<2;3;4M\x1b[<32;3;4M').mouse, [], 'right button and drags');
    assert.deepEqual(takeMouse('\x1b[<80;1;1M').mouse, [wheel(1)], 'Ctrl+wheel is still the wheel');
  });
  await t('a report cut between reads waits for its end; a lone Esc does not', () => {
    const first = takeMouse('hi\x1b[<64;1');
    assert.deepEqual(first, { rest: 'hi', mouse: [], pending: '\x1b[<64;1' });
    assert.deepEqual(takeMouse(first.pending + '0;5M'), { rest: '', mouse: [wheel(1)], pending: '' });
    assert.deepEqual(takeMouse('\x1b'), { rest: '\x1b', mouse: [], pending: '' });
    assert.deepEqual(takeMouse('\x1b[A'), { rest: '\x1b[A', mouse: [], pending: '' });
  });
  await t('a hard wrap cuts at the width and carries the style across the cut', () => {
    assert.deepEqual(hardWrap('abcdef', 4), ['abcd', 'ef']);
    assert.deepEqual(hardWrap('\x1b[36mabcdef\x1b[39m', 4), ['\x1b[36mabcd\x1b[0m', '\x1b[36mef\x1b[39m']);
    assert.deepEqual(hardWrap('日本語', 4), ['日本', '語']);
  });
  await t('the rule above the input carries a note when there is one', () => {
    const plain = layout({ width: 40, height: 10, footer: ['f'], input: { prompt: '> ', text: '', cursor: 0 } });
    const noted = layout({ width: 40, height: 10, footer: ['f'], note: 'scrolled', input: { prompt: '> ', text: '', cursor: 0 } });
    const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(strip(plain.rows[0]), '─'.repeat(39));
    assert.match(strip(noted.rows[0]), /^── scrolled ─+$/);
    assert.equal(strip(noted.rows[0]).length, 39);
  });

  console.log('\nwho said what');
  const { userMessage, promptFor } = require('../out/hosts/tui/terminal/terminal');
  const plain = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
  await t('a sent message reads as the user\'s, with its mode after it', () => {
    assert.equal(plain(userMessage('fix the bug', 'agent', 60)), 'you › fix the bug  · agent');
    // Wrapped as it was in the input box, under the label.
    assert.equal(plain(userMessage('a b c d e f g h', 'chat', 12)).replace(/ +\n/g, '\n'), 'you › a b c\n      d e f\n      g h  · chat');
  });
  await t('the prompt is a marker, not a speaker', () => {
    assert.equal(plain(promptFor('operator')), '❯ ');
  });

  console.log('\nscroll bar and points');
  const { scrollbar, clickTarget, neighbour, barRow, pointLabel } = require('../out/hosts/tui/terminal/window/scrollbar');
  const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
  const points = [{ row: 0, kind: 'user' }, { row: 3, kind: 'agent' }, { row: 50, kind: 'user' }, { row: 55, kind: 'agent' }, { row: 90, kind: 'user' }];
  await t('no bar while the whole conversation fits', () => assert.deepEqual(scrollbar(10, 10, 0, points), []));
  await t('the thumb covers the share in view, and each point is a dot where it falls', () => {
    const bar = scrollbar(10, 100, 50, points).map(strip).join('');
    // Rows 0 and 5 hold a message and its reply each; row 5 is also the thumb, and the dot shows over it.
    assert.equal(bar, '◆││││◆│││◆');
    const coloured = scrollbar(10, 100, 20, []);
    assert.deepEqual(coloured.map(strip), ['│', '│', '┃', '│', '│', '│', '│', '│', '│', '│']);
  });
  await t('messages and replies have their own shapes, so colour is not needed to tell them', () => {
    const bar = scrollbar(10, 12, 0, [{ row: 0, kind: 'user' }, { row: 6, kind: 'agent' }]).map(strip);
    assert.deepEqual([bar[0], bar[5]], ['◆', '•']);
  });
  await t('the rule names the point in view among its own kind', () => {
    assert.equal(pointLabel(points, 50), '◆ your message 2 of 3');
    assert.equal(pointLabel(points, 52), '◆ your message 2 of 3');
    assert.equal(pointLabel(points, 60), '• reply 2 of 2');
    assert.equal(pointLabel([], 5), undefined);
  });
  await t('a user message wins a bar row it shares with a reply', () => {
    assert.equal(barRow(0, 100, 10), barRow(3, 100, 10));
    assert.match(scrollbar(10, 100, 50, points)[0], /36m/, 'cyan, the user colour');
  });
  await t('a click on a dot goes to that point, elsewhere to that share', () => {
    assert.equal(clickTarget(5, 10, 100, points), 50);
    assert.equal(clickTarget(7, 10, 100, points), 70);
  });
  await t('the previous point is strictly above the top, the next strictly below', () => {
    assert.equal(neighbour(points, 50, -1).row, 3);
    assert.equal(neighbour(points, 50, 1).row, 55);
    assert.equal(neighbour(points, 0, -1), undefined);
    assert.equal(neighbour(points, 90, 1), undefined);
  });

  console.log('\ncompletion');
  const { tokenAt, rankCommands, rankChoices, ghostFor, firstWord } = require('../out/hosts/tui/terminal/complete');
  const cmds = [
    { name: 'mode', hint: '', args: async () => [] },
    { name: 'model', hint: '' },
    { name: 'allow', hint: '', args: 'folders' },
    { name: 'review', hint: '', placeholder: '[pr number]' },
  ];
  await t('the command name, then its argument, then nothing past it', () => {
    assert.deepEqual(tokenAt('/mo', 3, cmds), { kind: 'commands', start: 0, end: 3, query: 'mo' });
    assert.equal(tokenAt('/', 0, cmds).query, '');
    const arg = tokenAt('/mode op', 8, cmds);
    assert.equal(arg.kind, 'args'); assert.equal(arg.query, 'op'); assert.equal(arg.start, 6);
    assert.equal(tokenAt('/allow ~/', 9, cmds).kind, 'folders');
    assert.equal(tokenAt('/model x', 8, cmds), undefined);
    assert.equal(tokenAt('/mode', 5, cmds).kind, 'commands');
  });
  await t('an @path completes anywhere, a command only at the start of one line', () => {
    assert.equal(tokenAt('see @src/a', 10, cmds).kind, 'files');
    assert.equal(tokenAt('see /mode', 9, cmds), undefined);
    assert.equal(tokenAt('/mode\nx', 5, cmds), undefined);
  });
  await t('commands and choices rank by what is typed, all of them before anything is', () => {
    assert.deepEqual(rankCommands('mdl', cmds).map((s) => s.value), ['/model']);
    assert.equal(rankCommands('', cmds).length, 4);
    assert.deepEqual(rankChoices('op', [{ value: 'agent' }, { value: 'operator' }]).map((s) => s.value), ['operator']);
  });
  await t('the suggestion: the pick, else history, else a placeholder', () => {
    assert.deepEqual(ghostFor('/mo', 3, '/mode', [], cmds), { text: 'de', accept: true });
    assert.equal(ghostFor('/mo', 3, '/model', [], cmds).text, 'del');
    assert.deepEqual(ghostFor('fix', 3, undefined, ['fix the tests', 'fix the bug'], cmds), { text: ' the bug', accept: true });
    assert.deepEqual(ghostFor('/review ', 8, undefined, [], cmds), { text: '[pr number]', accept: false });
  });
  await t('no suggestion mid-text, past a newline, or when the pick does not extend what is typed', () => {
    assert.equal(ghostFor('fix', 1, undefined, ['fix the bug'], cmds), undefined);
    assert.equal(ghostFor('a\nfix', 5, undefined, ['a\nfix it'], cmds), undefined);
    assert.equal(ghostFor('/mdl', 4, '/model', ['/mdl x'], cmds), undefined);
  });
  await t('Alt+→ takes one word of it', () => assert.equal(firstWord(' the bug'), ' the'));
  await t('the suggestion is drawn after the cursor, which stays put', () => {
    const w = wrapInput('> ', 'fi', 2, 20, 'x it');
    assert.deepEqual(w.rows, ['> fix it']);
    assert.deepEqual([w.cursorRow, w.cursorCol], [0, 4]);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
