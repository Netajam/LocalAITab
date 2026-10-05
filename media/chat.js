const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let streaming = false, current = null;
let usage = null;
let mode = 'chat';

const MODE_HINTS = {
  chat: 'one shot, context you pick',
  agent: 'search / read_file / insert_change - edits still need your approval',
  operator: 'edits files directly, runs shell commands - you approve each command',
};

// Render only. The extension echoes every setMode back as a 'mode' message,
// so posting from here would bounce between the two sides forever.
function showMode(next) {
  mode = MODE_HINTS[next] ? next : 'chat';
  $('mChat').classList.toggle('on', mode === 'chat');
  $('mAgent').classList.toggle('on', mode === 'agent');
  $('mOperator').classList.toggle('on', mode === 'operator');
  $('modeHint').textContent = MODE_HINTS[mode];
}

function setMode(next) {
  showMode(next);
  vscode.postMessage({ type: 'setMode', mode: mode });
}

function fmt(n) { return n.toLocaleString(); }

// Estimated because Ollama exposes no tokenizer endpoint; the ratio is
// corrected from prompt_eval_count after every reply, so it converges.
function renderMeter() {
  if (!usage) return;
  const draft = $('input').value.length;
  const chars = usage.systemChars + usage.contextChars + usage.historyChars + draft;
  const tokens = Math.round(chars / usage.charsPerToken);
  const win = usage.windowTokens;

  if (!win) {
    $('meter').innerHTML = '<b>~' + fmt(tokens) + '</b> tokens (context window unknown)';
    $('bar').style.width = '0%';
    return;
  }

  // Generation needs room too: the reply competes for the same window.
  const withReply = tokens + usage.reserveTokens;
  const pct = Math.min(100, (withReply / win) * 100);
  const level = pct > 95 ? 'crit' : pct > 75 ? 'warn' : 'ok';

  $('bar').style.width = pct.toFixed(1) + '%';
  $('bar').className = level;

  $('cap').classList.toggle('hidden', !usage.capTokens);
  if (usage.capTokens) {
    const capAt = Math.min(100, ((usage.capTokens + usage.reserveTokens) / win) * 100);
    $('cap').style.left = capAt.toFixed(1) + '%';
    $('cap').title = 'attachment cap: ' + fmt(usage.capTokens) + ' tokens';
  }

  $('meter').innerHTML =
    '<span class="' + level + '">~' + fmt(tokens) + '</span> + ' + fmt(usage.reserveTokens) +
    ' reply / <b>' + fmt(win) + '</b> tokens (' + pct.toFixed(0) + '%)' +
    '<span class="dim">' + meterNotes().map((n) => ' &middot; ' + n).join('') + '</span>';
}

// The dim trailer of the meter: which window, how long the history, and the
// last exact count when the model has reported one.
function meterNotes() {
  const notes = [usage.windowRunning ? 'running window' : 'model max, not loaded'];
  if (usage.turns) notes.push(usage.turns + ' turn' + (usage.turns > 1 ? 's' : ''));
  if (usage.lastPromptTokens) notes.push('last prompt <b>' + fmt(usage.lastPromptTokens) + '</b> exact');
  return notes;
}

function esc(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Markdown lives in markdown.js; fenced blocks keep their Copy/Insert buttons.
function render(text) {
  return '<div class="md">' + renderMarkdown(text) + '</div>';
}

function addMessage(who, cls) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.innerHTML = '<div class="who">' + who + '</div><div class="body"></div>';
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
  return el.querySelector('.body');
}

// What the in-flight reply is waiting on, shown under it until it ends.
const PHASES = {
  context: 'gathering context',
  loading: 'loading model',
  prompt: 'reading prompt',
  thinking: 'thinking',
  generating: 'generating',
  tool: 'running tool',
};
let statusTimer = null;

function setStatus(phase, detail) {
  if (!current) return;
  if (!current.status) {
    current.status = document.createElement('div');
    current.status.className = 'status';
    current.el.parentNode.appendChild(current.status);
  }
  const since = Date.now();
  const paint = () => {
    current && current.status && (current.status.innerHTML =
      '<span class="spin"></span><b>' + esc(PHASES[phase] || phase) + '</b>' +
      (detail ? ' <span class="dim">' + esc(detail) + '</span>' : '') +
      ' <span class="dim">' + ((Date.now() - since) / 1000).toFixed(1) + 's</span>');
  };
  clearInterval(statusTimer);
  statusTimer = setInterval(paint, 200);
  paint();
  $('log').scrollTop = $('log').scrollHeight;
}

function clearStatus() {
  clearInterval(statusTimer);
  statusTimer = null;
  if (current && current.status) { current.status.remove(); current.status = null; }
}

$('log').addEventListener('click', (e) => {
  const c = e.target.getAttribute && e.target.getAttribute('data-copy');
  const i = e.target.getAttribute && e.target.getAttribute('data-insert');
  if (c) vscode.postMessage({ type: 'copy', code: decodeURIComponent(c) });
  if (i) vscode.postMessage({ type: 'insert', code: decodeURIComponent(i) });
});

function send() {
  const t = $('input').value;
  if (!t.trim()) return;

  const cmd = chatCommands.parseCommand(t, skills);
  // Built-in commands run at once; a message, skills included, waits for the reply in flight.
  if (streaming && (!cmd || cmd.skill)) return;
  $('input').value = '';
  hideSuggest();
  if (cmd) {
    renderMeter();
    runCommand(cmd);
    return;
  }
  // "//text" is the escape for a message that really starts with a slash.
  vscode.postMessage({ type: 'send', text: t.replace(/^(\s*)\/\//, '$1/') });
}

function note(html, cls) {
  addMessage('LocalAITab Chat', 'note').innerHTML = '<span class="' + (cls === undefined ? 'dim' : cls) + '">' + html + '</span>';
}

// Built-ins that only forward to the extension: the message type, and the
// field that carries the argument for those that take one. The mode switches
// and /help are handled in runCommand.
const COMMAND_MESSAGES = {
  attach: { type: 'attach', argAs: 'arg' },
  detach: { type: 'detach', argAs: 'arg' },
  unpin: { type: 'unpin', argAs: 'arg' },
  allow: { type: 'allow', argAs: 'arg' },
  find: { type: 'plan', argAs: 'task' },
  new: { type: 'newSession' },
  history: { type: 'pickSession' },
  clear: { type: 'reset' },
  stats: { type: 'stats' },
  skills: { type: 'listSkills' },
};

function commandHelp() {
  return '<table class="cmds">' + chatCommands.allCommands(skills).map(function (c) {
    return '<tr><td><code>/' + c.name + (c.arg ? ' ' + esc(c.arg) : '') + '</code></td><td>' + esc(c.help) + '</td></tr>';
  }).join('') + '</table><div class="dim">Start a message with <code>//</code> to send a literal slash.</div>';
}

function runCommand(cmd) {
  if (cmd.error) { note(esc(cmd.error), 'err'); return; }
  if (cmd.skill) {
    vscode.postMessage({ type: 'skill', name: cmd.name, arg: cmd.arg, text: '/' + cmd.name + (cmd.arg ? ' ' + cmd.arg : '') });
    return;
  }
  if (MODE_HINTS[cmd.name]) { setMode(cmd.name); return; }
  if (cmd.name === 'help') { note(commandHelp(), ''); return; }
  // parseCommand lets through only built-ins, so this is one of COMMAND_MESSAGES.
  const { type, argAs } = COMMAND_MESSAGES[cmd.name];
  vscode.postMessage(argAs ? { type: type, [argAs]: cmd.arg } : { type: type });
}

// Skills found on disk, sent by the extension; they complete like commands.
let skills = [];

function listSkills(problems) {
  if (!skills.length && !problems.length) {
    note('No skills found. Run <b>LocalAITab: New Skill</b>, or add a folder with a SKILL.md under ' +
      '<code>.localaitab/skills/</code> in the workspace or <code>~/.localaitab/skills/</code>.');
    return;
  }
  note('<table class="cmds">' + skills.map(function (s) {
    return '<tr><td><code>/' + esc(s.name) + (s.arg ? ' ' + esc(s.arg) : '') + '</code></td><td>' + esc(s.help) +
      '<div class="dim">' + esc(s.dir) + '</div></td></tr>';
  }).join('') + '</table>' + problems.map(function (p) {
    return '<div class="err">skipped ' + esc(p) + '</div>';
  }).join(''), '');
}

// Suggestion list shown while a command name is being typed.
let suggestions = [], suggestAt = 0;

function hideSuggest() { suggestions = []; $('suggest').classList.add('hidden'); }

function renderSuggest() {
  suggestions = chatCommands.suggest($('input').value, skills);
  if (!suggestions.length) { hideSuggest(); return; }
  suggestAt = Math.min(suggestAt, suggestions.length - 1);
  $('suggest').innerHTML = suggestions.map(function (c, i) {
    return '<div class="sg' + (i === suggestAt ? ' on' : '') + '" data-i="' + i + '"><code>/' + c.name +
      '</code>' + (c.arg ? ' <span class="dim">' + esc(c.arg) + '</span>' : '') +
      '<span class="dim sgHelp">' + esc(c.help) + '</span></div>';
  }).join('');
  $('suggest').classList.remove('hidden');
}

function acceptSuggest(i) {
  const c = suggestions[i];
  if (!c) return;
  $('input').value = '/' + c.name + (c.arg ? ' ' : '');
  hideSuggest();
  $('input').focus();
  // A command that takes nothing has nothing left to type.
  if (!c.arg) send();
}

$('suggest').addEventListener('mousedown', function (e) {
  const row = e.target.closest && e.target.closest('.sg');
  if (row) { e.preventDefault(); acceptSuggest(+row.dataset.i); }
});

let planFiles = [];

function planRender(m) {
  $('planPane').classList.remove('hidden');
  $('planHead').innerHTML =
    '<b>' + m.totalHits + '</b> hits in <b>' + m.files.length + '</b> files &middot; ' + m.ms + 'ms' +
    '<span class="dim"> &middot; tick what is relevant; nothing is sent until you attach</span>';

  $('planQueries').innerHTML = m.queries.map(function (q) {
    return '<div class="q"><code>' + esc(q.pattern) + '</code>' +
      (q.glob ? ' <span class="dim">in ' + esc(q.glob) + '</span>' : '') +
      (q.why ? '<div class="dim">' + esc(q.why) + '</div>' : '') + '</div>';
  }).join('') + (m.emptyQueries.length
    ? '<div class="dim">no hits: ' + m.emptyQueries.map(esc).join(', ') + '</div>' : '');

  planFiles = m.files;
  $('planFiles').innerHTML = m.files.map(function (f, fi) {
    var hits = f.hits.map(function (h, hi) {
      return '<label class="hit"><input type="checkbox" data-f="' + fi + '" data-h="' + hi + '">' +
        '<span class="ln">' + h.line + '</span><code>' + esc(h.text.trim().slice(0, 140)) + '</code></label>';
    }).join('');
    return '<div class="pf"><label class="pfh"><input type="checkbox" data-whole="' + fi + '">' +
      '<b>' + esc(f.path) + '</b> <span class="dim">' + f.hits.length + ' hit(s)</span></label>' +
      hits + '</div>';
  }).join('');
}

function planSelection() {
  var wholeFiles = [], lines = [];
  document.querySelectorAll('#planFiles input[data-whole]').forEach(function (el) {
    if (el.checked) wholeFiles.push(planFiles[+el.dataset.whole].path);
  });
  document.querySelectorAll('#planFiles input[data-f]').forEach(function (el) {
    if (!el.checked) return;
    var f = planFiles[+el.dataset.f];
    lines.push({ path: f.path, line: f.hits[+el.dataset.h].line });
  });
  return { wholeFiles: wholeFiles, lines: lines };
}

$('find').onclick = function () {
  var t = $('input').value;
  if (!t.trim()) { $('modeHint').textContent = 'type what you are looking for first'; return; }
  vscode.postMessage({ type: 'plan', task: t });
};
$('planAttach').onclick = function () {
  vscode.postMessage({ type: 'planSelect', selection: planSelection() });
  $('planPane').classList.add('hidden');
};
$('planAll').onclick = function () {
  document.querySelectorAll('#planFiles input[data-whole]').forEach(function (el) { el.checked = true; });
};
$('planNone').onclick = function () {
  document.querySelectorAll('#planFiles input').forEach(function (el) { el.checked = false; });
};
$('planClose').onclick = function () { $('planPane').classList.add('hidden'); };

$('sNew').onclick = () => vscode.postMessage({ type: 'newSession' });
$('sOpen').onclick = () => vscode.postMessage({ type: 'pickSession' });
$('sReveal').onclick = () => vscode.postMessage({ type: 'revealSessions' });

$('mChat').onclick = () => setMode('chat');
$('mAgent').onclick = () => setMode('agent');
$('mOperator').onclick = () => setMode('operator');
$('ab').onclick = () => vscode.postMessage({ type: 'stats' });
$('send').onclick = send;
$('stop').onclick = () => vscode.postMessage({ type: 'stop' });
$('reset').onclick = () => vscode.postMessage({ type: 'reset' });
$('input').addEventListener('input', () => { suggestAt = 0; renderSuggest(); renderMeter(); });
$('input').addEventListener('keydown', (e) => {
  if (suggestions.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      suggestAt = (suggestAt + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      renderSuggest();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault(); acceptSuggest(suggestAt); return;
    }
    if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('input').addEventListener('blur', hideSuggest);

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'skills') {
    skills = m.skills;
    if (m.show) listSkills(m.problems);
    return;
  }
  if (m.type === 'init') {
    $('chips').innerHTML = '';
    for (const k of m.kinds) {
      const b = document.createElement('button');
      b.className = 'chip' + (k.on ? ' on' : '');
      b.textContent = k.label;
      b.dataset.id = k.id;
      b.onclick = () => vscode.postMessage({ type: 'toggleKind', id: k.id });
      $('chips').appendChild(b);
    }
    $('model').textContent = m.model;
  }
  if (m.type === 'preview') {
    usage = m.usage;
    renderMeter();
    for (const c of document.querySelectorAll('.chip')) {
      c.classList.toggle('on', m.kinds.indexOf(c.dataset.id) >= 0);
    }
    const capPct = m.usage && m.usage.capTokens
      ? (m.chars / m.usage.charsPerToken) / m.usage.capTokens * 100 : 0;
    const atCap = capPct > 95;
    $('summary').innerHTML = m.pieces.length
      ? 'Attached <b>' + Math.round(m.chars / (m.usage ? m.usage.charsPerToken : 3.5)).toLocaleString() +
        '</b> tokens from ' + m.pieces.length + ' source(s)' +
        (atCap ? ' <span class="over">at the attachment cap - raise localAITab.chatContextPercent</span>' : '')
      : '<i>No context attached. The model will only see your question.</i>';
    $('anchor').innerHTML = m.anchor
      ? 'anchored to <b>' + esc(m.anchor) + '</b>'
      : '<span class="warn">no file open &mdash; file/folder/selection sources are empty</span>';
    $('detail').innerHTML =
      m.pieces.map((p) => '<div>' + esc(p.label + ' - ' + p.path) + ' (' + p.chars.toLocaleString() + ')</div>').join('') +
      m.skipped.map((s) => '<div class="err">skipped: ' + esc(s) + '</div>').join('');
  }
  if (m.type === 'userMessage') { addMessage('You', 'user').textContent = m.text; }

  if (m.type === 'mode') { showMode(m.mode); }

  if (m.type === 'agentBegin') {
    streaming = true; $('send').disabled = true; $('stop').disabled = false;
    current = { el: addMessage((m.label || 'agent') + ' - ' + m.model, 'bot'), text: '', trace: null };
    current.who = current.el.parentNode.querySelector('.who');
    current.trace = document.createElement('div');
    current.trace.className = 'trace';
    current.el.appendChild(current.trace);
  }

  if (m.type === 'status' && current) {
    if (m.contextChars !== undefined && current.who) {
      current.who.textContent += '  -  ' + m.contextChars.toLocaleString() + ' chars of context';
    }
    setStatus(m.phase, m.detail);
  }

  if (m.type === 'agentStep' && current) {
    const row = document.createElement('div');
    row.className = 'step' + (m.ok ? '' : ' bad');
    row.innerHTML =
      '<b>' + m.index + '. ' + esc(m.tool) + '</b> <span class="dim">' + esc(m.args) + '</span>' +
      '<div class="dim out">' + esc(m.result.split('\n').slice(0, 3).join(' | ')) + '</div>' +
      '<div class="dim">' + m.ms + 'ms</div>';
    current.trace.appendChild(row);
    $('log').scrollTop = $('log').scrollHeight;
  }

  if (m.type === 'agentEnd') {
    streaming = false; $('send').disabled = false; $('stop').disabled = true;
    clearStatus();
    showMode(mode);
    if (current) {
      const body = document.createElement('div');
      body.innerHTML = render(m.answer || (m.aborted ? '[stopped]' : '[no answer]'));
      current.el.appendChild(body);
      const warn = m.hitCap ? '<span class="warn"> - stopped at the step cap</span>' : '';
      const staged = m.staged ? ' - staged <b>' + esc(m.staged) + '</b> for review' : '';
      const changed = m.changed && m.changed.length
        ? ' - changed <b>' + m.changed.map(esc).join(', ') + '</b>' : '';
      current.el.insertAdjacentHTML('beforeend',
        '<div class="dim" style="margin-top:4px">' + m.steps + ' step(s) &middot; ' +
        fmt(m.promptTokens || 0) + ' prompt + ' + fmt(m.replyTokens || 0) + ' reply tokens &middot; ' +
        m.ms + 'ms' + staged + changed + warn + '</div>');
    }
    current = null;
  }

  if (m.type === 'planBegin') {
    $('planPane').classList.remove('hidden');
    $('planHead').textContent = 'planning searches...';
    $('planQueries').innerHTML = ''; $('planFiles').innerHTML = '';
  }
  if (m.type === 'planSketch') {
    $('planHead').textContent =
      'sketched ' + m.files + ' files, ' + m.symbols + ' identifiers - asking the model for queries...';
  }
  if (m.type === 'planResult') { planRender(m); }

  if (m.type === 'stats') {
    const c = m.tally.chat, a = m.tally.agent, o = m.tally.operator;
    const row = (n, x) => n + ': ' + x.runs + ' run(s), ' +
      (x.runs ? Math.round(x.ms / x.runs) : 0) + 'ms avg, ' +
      (x.runs ? Math.round((x.promptTokens + x.replyTokens) / x.runs) : 0) + ' tok avg' +
      (x.steps ? ', ' + (x.steps / Math.max(1, x.runs)).toFixed(1) + ' steps avg' : '');
    addMessage('A/B so far', 'bot').innerHTML =
      '<div class="dim">' + esc(row('chat', c)) + '<br>' + esc(row('agent', a)) + '<br>' + esc(row('operator', o)) + '</div>';
  }
  if (m.type === 'begin') {
    streaming = true; $('send').disabled = true; $('stop').disabled = false;
    current = { el: addMessage(m.model, 'bot'), text: '' };
    current.who = current.el.parentNode.querySelector('.who');
  }
  if (m.type === 'token' && current) {
    current.text += m.delta;
    current.el.innerHTML = render(current.text);
    $('log').scrollTop = $('log').scrollHeight;
  }
  if (m.type === 'end') {
    streaming = false; $('send').disabled = false; $('stop').disabled = true;
    clearStatus();
    if (current && m.promptTokens) {
      current.el.insertAdjacentHTML('beforeend',
        '<div class="dim" style="margin-top:4px">' + fmt(m.promptTokens) +
        ' prompt + ' + fmt(m.tokens || 0) + ' reply tokens &middot; ' + (m.ms || 0) + 'ms</div>');
    }
    if (current && m.aborted) current.el.innerHTML += '<i class="err"> [stopped]</i>';
    current = null;
  }
  if (m.type === 'error') {
    streaming = false; $('send').disabled = false; $('stop').disabled = true;
    clearStatus();
    addMessage('Error', 'bot').innerHTML = '<span class="err">' + esc(m.message) + '</span>';
    current = null;
  }
  if (m.type === 'cleared') { clearStatus(); $('log').innerHTML = ''; }
  if (m.type === 'notice') { note(esc(m.text), m.level === 'error' ? 'err' : 'dim'); }

  if (m.type === 'session') {
    $('sessionInfo').textContent = m.turns
      ? 'session ' + m.id.slice(0, 16) + '  -  ' + m.turns + ' turn' + (m.turns === 1 ? '' : 's') + ' saved'
      : 'new session';
  }

  if (m.type === 'replay') {
    var el = addMessage(m.role === 'user' ? 'You' : (m.mode === 'agent' || m.mode === 'operator' ? m.mode : 'assistant'),
                        m.role === 'user' ? 'user' : 'bot');
    if (m.role === 'user') el.textContent = m.content; else el.innerHTML = render(m.content);
  }
});

vscode.postMessage({ type: 'ready' });
