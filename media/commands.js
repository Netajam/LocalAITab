// Slash commands typed into the chat composer.
//
// Kept apart from chat.js, and free of DOM access, so the parser can be tested
// under node the same way markdown.js is.
(function (root) {
  'use strict';

  // `arg` is shown in the suggestion list; `needsArg` refuses to run without one.
  const COMMANDS = [
    { name: 'attach', arg: '[path or glob]', help: 'Attach files as context; absolute and ~/ paths reach outside the workspace. No argument opens the file picker.' },
    { name: 'detach', arg: '[path]', help: 'Remove attached files matching the path, or all of them.' },
    { name: 'unpin', arg: '[path or path:lines]', help: 'Drop pinned selections matching the argument, or all of them. Cmd+K L pins the selected lines.' },
    { name: 'allow', arg: '[folder]', help: 'Let agent mode read a folder outside the workspace until the panel closes. No argument opens a folder dialog.' },
    { name: 'find', arg: '<what you are after>', needsArg: true, help: 'Let the model plan ripgrep searches, then tick the hits.' },
    { name: 'chat', help: 'Switch to chat mode: one shot, the context you picked.' },
    { name: 'agent', help: 'Switch to agent mode: search, read_file, insert_change.' },
    { name: 'operator', help: 'Switch to operator mode: edits files directly and runs shell commands you approve.' },
    { name: 'new', help: 'Start a new session.' },
    { name: 'history', help: 'Resume a saved session.' },
    { name: 'clear', help: 'Clear the conversation shown and sent so far.' },
    { name: 'stats', help: 'Show the per-mode totals.' },
    { name: 'skills', help: 'List the skills found on disk, rescanning first.' },
    { name: 'help', help: 'List these commands.' },
  ];

  /**
   * Built-ins first, then skills as `{ name, arg, help }`. A skill named like a
   * built-in is dropped rather than allowed to replace it.
   */
  function allCommands(skills) {
    const taken = new Set(COMMANDS.map((c) => c.name));
    return COMMANDS.concat((skills || [])
      .filter((s) => !taken.has(s.name))
      .map((s) => ({ name: s.name, arg: s.arg || '', help: s.help || '', skill: true })));
  }

  /**
   * Splits "/name rest of line" into its parts. Returns null for ordinary text,
   * so a message that merely contains a slash is still sent to the model. A
   * leading "//" escapes: it sends the text with one slash removed. A skill
   * comes back with `skill: true`.
   */
  function parseCommand(text, skills) {
    // The name must start with a letter, which also rules out the "//" escape.
    const m = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!m) return null;
    const parsed = { name: m[1].toLowerCase(), arg: (m[2] || '').trim() };
    const command = allCommands(skills).find((c) => c.name === parsed.name);
    if (!command) return Object.assign(parsed, { error: 'Unknown command /' + parsed.name + '. Type /help for the list.' });
    if (command.needsArg && !parsed.arg) return Object.assign(parsed, { error: '/' + parsed.name + ' needs ' + command.arg + '.' });
    if (command.skill) parsed.skill = true;
    return parsed;
  }

  /** Commands matching what has been typed so far, while the name is still being typed. */
  function suggest(text, skills) {
    const m = /^\/([\w-]*)$/.exec(text);
    if (!m) return [];
    const prefix = m[1].toLowerCase();
    return allCommands(skills).filter((c) => c.name.startsWith(prefix));
  }

  root.chatCommands = { COMMANDS: COMMANDS, allCommands: allCommands, parseCommand: parseCommand, suggest: suggest };
  if (typeof module !== 'undefined') module.exports = root.chatCommands;
})(typeof window !== 'undefined' ? window : globalThis);
