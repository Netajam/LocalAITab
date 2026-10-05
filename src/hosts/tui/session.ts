import * as os from 'os';
import * as path from 'path';
import { Conversation, ConversationHost, StagedChange, Turn, TurnResult, LoopMode, Mode } from '../../core/harness/conversation';
import { TurnRecord, SESSIONS_DIR } from '../../core/harness/sessions';
import { LiveSession } from '../../core/harness/live';
import { collect } from './context';
import { Transcript, Asked, Answered, answeredBy } from './transcript';
import { diskWorkspace } from './disk';
import { renderMarkdown } from './markdown';
import { Options } from './options';
import { StepView, stepLine, stagedDiff, runSummary, bold, dim, cyan, green, red, yellow } from './render';
import { Terminal, Command, createTerminal, userMessage } from './terminal/terminal';

/** A built-in command: how it completes, and what it does with its argument. `false` leaves. */
interface BuiltIn extends Command {
  run(arg: string): string | false | Promise<string | false>;
  /** Other names it answers to. */
  aliases?: string[];
}

const MODES: Array<{ value: Mode; hint: string }> = [
  { value: 'chat', hint: 'answers from what you attach; no tools' },
  { value: 'agent', hint: 'reads and searches; stages one edit for you to approve' },
  { value: 'operator', hint: 'edits files directly; asks before each command' },
];

const HELP = `${bold('Commands')}
  /mode chat|agent|operator
                         chat answers from what you attach, with no tools;
                         agent reads and stages one edit for you to approve;
                         operator edits directly and asks before each command
  /model <name>          switch model
  /allow <dir>           let the agent read a folder outside the workspace
  /skills                list the skills found; /<skill> [args] runs one
  /resume                pick up an earlier conversation in this folder; the
                         list opens as you type the space (localaitab -c reopens
                         the latest)
  /clear                 forget the conversation; the next message starts a new one
  /quit                  leave (or Ctrl+D on an empty prompt)

${bold('Context')}
  @path                  attach a file, or the source files of a folder; a
                         fuzzy finder opens as you type (Tab opens a folder)
  @~/… @/…               browse outside the workspace

${bold('Keys')}  F1 shows them all below the prompt; Shift+Tab switches mode,
  Esc gives vim normal mode to edit the message, i or a goes back to typing.`;

/**
 * One conversation in the terminal: a prompt, the tool loop behind it, and
 * the approvals the loop needs from the user along the way.
 */
export class Session {
  private readonly term: Terminal;
  private readonly conversation: Conversation;
  private readonly transcript: Transcript;
  /** ~/.localaitab/sessions/<pid>.json, for a monitor to see this session running. */
  private readonly live: LiveSession;
  private running?: AbortController;
  /** What the last skill scan skipped, and why; /skills shows it. */
  private skillProblems: string[] = [];
  private readonly log: ConversationHost['log'] = {
    appendLine: (line) => { if (process.env.LOCALAITAB_DEBUG) { this.term.print(dim(line)); } },
  };

  constructor(private readonly o: Options) {
    const term = this.term = createTerminal(o.root);
    this.conversation = new Conversation({
      workspace: diskWorkspace,
      approve: (command, cwd) => this.approve(command, cwd),
      log: this.log,
      settings: () => this.o,
    });
    this.transcript = new Transcript(o.projectsDir, o.root, this.log, SESSIONS_DIR);
    this.live = new LiveSession({ entrypoint: 'localaitab-tui', cwd: o.root, sessionId: this.transcript.current, tmux: true, log: this.log });
    this.transcript.store.onChange((id, title) => this.live.setSession(id, title));
    term.onInterrupt(() => this.running?.abort());
    term.onCycleMode(() => {
      const at = MODES.findIndex((m) => m.value === this.o.mode);
      this.o.mode = MODES[(at + 1) % MODES.length].value;
      this.showInfo();
    });
    this.showInfo();
  }

  /** Hands the terminal back as it was, and says this session is no longer running. */
  close(): void {
    this.live.close();
    this.term.close();
  }

  /** Reopens what the command line asked for: a session by id, or the latest. False when that failed. */
  async reopen(): Promise<boolean> {
    const id = this.o.resume ?? (this.o.continue ? await this.transcript.latest() : undefined);
    const failed = id ? await this.resume(id) : this.o.continue ? dim('no earlier conversation here to continue') : '';
    if (failed) { this.term.print(failed); }
    return !failed;
  }

  /** The interactive loop. Resolves when the user leaves. */
  async repl(): Promise<void> {
    await this.refreshSkills();
    this.term.print(`${bold('localaitab')} ${dim('· type a task, @ to attach files, / for commands, F1 for keys')}`);
    await this.reopen();

    for (;;) {
      const line = await this.term.read();
      if (line === undefined) { return; }
      if (!line.trim()) { continue; }
      if (line.startsWith('/')) {
        const reply = await this.command(line.trim());
        if (reply === false) { return; }
        if (reply) { this.term.print(reply); }
        continue;
      }
      await this.run(line);
    }
  }

  /** Runs one task to the end and saves it; a failed run is reported, not thrown. `display` is what was typed. */
  async run(task: string, display = task): Promise<boolean> {
    const controller = new AbortController();
    this.running = controller;
    this.live.setStatus('busy');
    try {
      const { block, sources, chars } = await this.attach(task);
      const asked: Asked = { question: task, display, mode: this.o.mode, model: this.o.model, sources, contextChars: chars };
      const mode = this.o.mode;
      await this.transcript.ask(asked);
      const answered = mode === 'chat'
        ? await this.chat(task, block, controller.signal)
        : await this.loop(mode, task, block, controller.signal);
      if (answered) { await this.transcript.answer(asked, answered); }
      return answered !== undefined;
    } catch (err) {
      this.term.status();
      this.term.preview();
      this.term.print(red(`error: ${(err as Error).message}`));
      return false;
    } finally {
      this.running = undefined;
      this.live.setStatus('idle');
    }
  }

  /**
   * Chat mode: one streamed answer, drawn as markdown while it arrives and
   * printed whole when it is done. Stopping keeps what had arrived.
   */
  private async chat(question: string, contextBlock: string, signal: AbortSignal): Promise<Answered | undefined> {
    let text = '';
    let drawn = 0;
    this.term.status('thinking');
    const result = await this.conversation.chat(question, {
      contextBlock, signal,
      onToken: (delta) => {
        text += delta;
        // Redrawn at most every 50 ms: rendering per token is wasted on a fast model.
        if (Date.now() - drawn < 50) { return; }
        drawn = Date.now();
        this.term.status('writing');
        this.term.preview(renderMarkdown(text, this.term.width - 1).split('\n'));
      },
    });
    this.term.preview();
    this.term.status();
    if (result.answer) { this.term.print('\n' + renderMarkdown(result.answer, this.term.width - 1) + '\n'); }
    this.term.print(result.aborted ? yellow('stopped') : runSummary(result));
    if (result.aborted || !result.answer.trim()) { return undefined; }
    return { content: result.answer, promptTokens: result.promptTokens, replyTokens: result.replyTokens, ms: result.totalMs };
  }

  /** Agent and operator mode: a tool loop, then whatever review its outcome needs. Undefined when stopped. */
  private async loop(mode: LoopMode, task: string, contextBlock: string, signal: AbortSignal): Promise<Answered | undefined> {
    this.term.status('thinking');
    const result = await this.conversation.run(mode, task, this.turn(signal, contextBlock));
    this.term.status();
    return (await this.conclude(result, signal)) ? answeredBy(result) : undefined;
  }

  async refreshSkills(): Promise<void> {
    const problems = await this.conversation.loadSkills(this.o.skillPaths, this.o.root);
    this.skillProblems = problems;
    for (const p of problems) { this.log.appendLine(`[skills] skipped ${p}`); }
    const skills = this.conversation.invocableSkills().map((s): Command => ({
      name: s.name, hint: s.description, placeholder: s.argumentHint || undefined,
    }));
    this.term.setCommands([...this.builtIns, ...skills]);
  }

  /** The built-in commands: what each completes to and what it does. */
  private readonly builtIns: BuiltIn[] = [
    { name: 'mode', hint: 'chat, agent or operator', args: async () => MODES, run: (arg) => this.setMode(arg) },
    {
      name: 'model', hint: 'switch model', run: (arg) => this.setModel(arg),
      args: async () => (await this.conversation.models()).map((m) => ({ value: m, hint: m === this.o.model ? 'current' : undefined })),
    },
    { name: 'allow', hint: 'let the agent also read a folder', args: 'folders', run: (arg) => this.allow(arg) },
    { name: 'skills', hint: 'list skills', run: async () => { await this.refreshSkills(); return this.skillList(); } },
    { name: 'resume', hint: 'pick up an earlier conversation', args: () => this.transcript.choices(), run: (arg) => this.resumeCommand(arg) },
    {
      name: 'clear', hint: 'forget the conversation; the next message starts a new one',
      run: () => { this.conversation.clear(); this.transcript.startOver(); return dim('conversation cleared'); },
    },
    { name: 'help', hint: 'commands and shortcuts', run: () => HELP },
    { name: 'quit', hint: 'leave', aliases: ['exit'], run: () => false },
  ];

  /** Reads what the task @mentions and says what goes along with it. */
  private async attach(task: string): Promise<{ block: string; sources: string[]; chars: number }> {
    const { block, attached, skipped } = await collect(task, this.o.root, this.o.contextMaxChars);
    if (attached.length) {
      const list = attached.map((a) => `${cyan(a.path)} ${dim(`${a.files > 1 ? `${a.files} files, ` : ''}${(a.chars / 1000).toFixed(1)}k chars`)}`);
      this.term.print(`${dim('attached')} ${list.join(dim(', '))}`);
    }
    for (const s of skipped) { this.term.print(yellow(`  left out ${s}`)); }
    return { block, sources: attached.map((a) => a.path), chars: attached.reduce((n, a) => n + a.chars, 0) };
  }

  /** /resume: with a session, reopen it; bare, say how to pick one. */
  private async resumeCommand(id: string): Promise<string> {
    if (id) { return this.resume(id); }
    const count = (await this.transcript.choices()).length;
    return count ? dim(`${count} earlier conversation(s) here: type /resume and a space to pick one`) : dim('no earlier conversations in this folder yet');
  }

  /** Makes a saved conversation the thread again and plays it back. Resolves to an error to show, or ''. */
  private async resume(id: string): Promise<string> {
    const turns = await this.transcript.open(id);
    if (!turns.length) { return red(`no saved conversation ${id}`); }
    this.conversation.resume(turns.map((t) => ({ role: t.role, content: t.content })));
    const asked = turns.filter((t) => t.role === 'user').length;
    const header: [string, undefined] = [bold('resumed') + dim(` · ${asked} question${asked === 1 ? '' : 's'} · earlier turns below`) + '\n', undefined];
    // One print per turn, so each is a point to jump to, as it was the first time.
    const turnsShown = turns.map((t): [string, 'user' | 'agent'] => [this.replayed(t), t.role === 'user' ? 'user' : 'agent']);
    for (const [text, mark] of [header, ...turnsShown]) { this.term.print(text, mark); }
    return '';
  }

  /** A saved turn as it looked: the question as the user's, the answer rendered. */
  private replayed(t: TurnRecord): string {
    if (t.role === 'assistant') { return renderMarkdown(t.content, this.term.width - 1) + '\n'; }
    const attached = t.sources?.length ? dim(`  (attached ${t.sources.join(', ')})`) : '';
    return userMessage(t.display ?? t.content, t.mode, this.term.width - 1) + attached;
  }

  private turn(signal: AbortSignal, contextBlock: string): Turn {
    return {
      root: this.o.root,
      extraRoots: this.o.extraRoots,
      contextBlock,
      signal,
      events: this.transcript.record({
        onThinking: (step, max) => this.term.status(`thinking ${dim(`step ${step} of ${max}`)}`),
        onToolStart: (tool) => this.term.status(`running ${cyan(tool)}`),
        onStep: (step: StepView) => this.term.print(stepLine(step)),
      }),
    };
  }

  /**
   * Prints how the run ended, then offers a staged change for review or
   * lists what operator mode changed. False when the user stopped it.
   */
  private async conclude(result: TurnResult, signal: AbortSignal): Promise<boolean> {
    if (result.aborted) {
      this.term.print(yellow('stopped'));
      return false;
    }
    if (result.answer) { this.term.print('\n' + renderMarkdown(result.answer, this.term.width - 1) + '\n'); }
    this.term.print(runSummary(result));
    if (result.mode === 'agent' && result.staged) { await this.review(result.staged, signal); }
    if (result.mode === 'operator' && result.changed.length) { this.term.print(dim(`changed: ${result.changed.join(', ')}`)); }
    return true;
  }

  /**
   * Shows the staged change and applies it on a yes. The file is read again
   * just before writing, and the change refused if the text it replaces has
   * moved since the agent read it.
   */
  private async review(staged: StagedChange, signal: AbortSignal): Promise<void> {
    this.term.print('\n' + stagedDiff(staged, await diskWorkspace.read(staged.file)));
    const yes = await this.term.choose('Apply this change?', [{ key: 'y', label: 'apply' }, { key: 'n', label: 'discard' }], signal);
    this.term.print(yes === 'y' ? await this.apply(staged) : dim('discarded'));
  }

  /** Writes a staged change, unless the text it replaces has moved; says which. */
  private async apply(staged: StagedChange): Promise<string> {
    const now = await diskWorkspace.read(staged.file);
    if (now.slice(staged.at, staged.at + staged.before.length) !== staged.before) {
      return red(`${staged.path} changed since the agent read it; nothing written.`);
    }
    await diskWorkspace.replace(staged.file, staged.at, staged.before.length, staged.after);
    return green(`applied to ${staged.path}`);
  }

  /** Shows an operator command and asks; Ctrl+C meanwhile declines it along with the run. */
  private async approve(command: string, cwd: string): Promise<'once' | 'all' | undefined> {
    this.term.status();
    this.live.setStatus('waiting');
    const answer = await this.term.choose(
      `Run ${bold(command)} ${dim(`in ${cwd}`)}?`,
      [{ key: 'y', label: 'run' }, { key: 'a', label: 'run all this request' }, { key: 'n', label: 'decline' }],
      this.running?.signal,
    );
    this.live.setStatus('busy');
    return answer === 'a' ? 'all' : answer === 'y' ? 'once' : undefined;
  }

  /** Handles a /command. Resolves to what to print, or false to leave. */
  private async command(line: string): Promise<string | false> {
    const [name, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    const builtIn = this.builtIns.find((b) => b.name === name || b.aliases?.includes(name));
    if (builtIn) { return builtIn.run(arg); }
    const prompt = this.conversation.skillPrompt(name, arg, this.o.mode);
    if (prompt === undefined) { return red(`no command or skill named /${name}; /help lists them`); }
    await this.run(prompt, line);
    return '';
  }

  private setModel(arg: string): string {
    if (arg) { this.o.model = arg; this.showInfo(); }
    return dim(`model: ${this.o.model}`);
  }

  /** Grants are matched as absolute paths, so a relative one is taken from the workspace. */
  private allow(arg: string): string {
    if (arg) { this.o.extraRoots.push(path.resolve(this.o.root, arg.replace(/^~(?=\/|$)/, os.homedir()))); }
    return dim(`allowed: ${this.o.extraRoots.join(', ') || '(nothing outside the workspace)'}`);
  }

  private setMode(arg: string): string {
    const mode = MODES.find((m) => m.value === arg);
    if (mode) { this.o.mode = mode.value; this.showInfo(); }
    else if (arg) { return red(`the modes are ${MODES.map((m) => m.value).join(', ')}`); }
    return dim(`mode: ${this.o.mode}`);
  }

  private skillList(): string {
    const listed = this.conversation.invocableSkills().map((s) => {
      const manual = s.modelInvocable ? '' : dim(' (only when you run it)');
      return `  ${cyan('/' + s.name)} ${dim(s.description)}${manual}`;
    });
    const empty = listed.length ? [] : [dim('no skills: add one to .localaitab/skills, or reference one in .localaitab/skills.json')];
    const skipped = this.skillProblems.map((p) => yellow(`  skipped ${p}`));
    return [...listed, ...empty, ...skipped].join('\n');
  }

  private showInfo(): void {
    this.term.setInfo({ mode: this.o.mode, model: this.o.model, root: this.o.root });
  }
}
