import { createHash, randomUUID } from 'crypto';
import { readFileSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Log } from './tools';
import type { AgentEvents, AgentStep, ModelReply } from './agent';

/**
 * Local, on-disk conversation history, in the shape Claude Code keeps its own.
 *
 * One transcript per session at `projects/<folder>/<sessionId>.jsonl`, where
 * `folder` is the workspace with every character but ASCII letters and digits
 * turned into `-`, exactly as Claude Code files its sessions under
 * `~/.claude/projects`. A tool that reads Claude Code's transcripts (a session
 * monitor, say) reads localaitab's by looking in `~/.localaitab` instead of `~/.claude`.
 * localaitab never writes into `~/.claude`: Claude Code would list its sessions
 * as its own.
 *
 * Each line is appended as it happens and never rewritten, so a reader that
 * remembers where it stopped reads only what is new, and a crash costs at most
 * a torn last line. What a reader looks for:
 *
 * - `user` lines: a prompt (`origin.kind` "human" when typed, not a /skill),
 *   or a tool's result (`tool_result` block, `toolUseResult`).
 * - `assistant` lines: one per model reply, with its `message.id`, its tool
 *   calls as `tool_use` blocks, and `message.usage` from Ollama's counts.
 * - `ai-title`: the session's title.
 *
 * localaitab's own fields (`mode`, `model`, `sources`, `ms`, `display`, …) ride
 * on the lines as extra keys, and `turnEnd` marks the reply that closes a
 * turn: the answer that goes back in the thread when a session is resumed.
 *
 * Nothing here leaves the machine.
 */

export type Mode = 'chat' | 'agent' | 'operator';

/** One side of a finished turn, as a session is replayed and resumed. */
export interface TurnRecord {
  role: 'user' | 'assistant';
  content: string;
  /** What the user typed, when that differs from what was sent: a /skill invocation. */
  display?: string;
  at: string;
  mode: Mode;
  model?: string;
  promptTokens?: number;
  replyTokens?: number;
  ms?: number;
  /** Labels of the context sources attached to this turn. */
  sources?: string[];
  contextChars?: number;
  steps?: number;
  staged?: string;
}

/** A question as it goes in the file, before anything has run. */
export type PromptRecord = Pick<TurnRecord, 'content' | 'display' | 'mode' | 'model' | 'sources' | 'contextChars'>;

/** The reply that closes a turn. */
export type AnswerRecord = Omit<TurnRecord, 'role' | 'at' | 'display' | 'sources' | 'contextChars'>;


export interface SessionSummary {
  id: string;
  created: string;
  updated: string;
  turns: number;
  /** The session's title: its first question, shortened. */
  title: string;
  bytes: number;
}

/** Where localaitab keeps its state. LOCALAITAB_HOME moves it, for tests or a synced folder. */
export const LOCALAITAB_DIR = process.env.LOCALAITAB_HOME || path.join(os.homedir(), '.localaitab');

/** Transcripts, one folder per workspace, as Claude Code's `~/.claude/projects`. */
export const PROJECTS_DIR = path.join(LOCALAITAB_DIR, 'projects');

/**
 * Before transcripts took Claude Code's shape they lived here, one folder per
 * workspace; `convertSessions` moves them to PROJECTS_DIR. The folder then
 * holds the live file of each running session, as `~/.claude/sessions`.
 */
export const SESSIONS_DIR = path.join(LOCALAITAB_DIR, 'sessions');

/** localaitab's version, from the package.json above out/ (repository, extension) or lib/ (installed terminal). */
export const VERSION: string = (() => {
  for (const up of [['..', '..', '..'], ['..', '..']]) {
    try {
      return (JSON.parse(readFileSync(path.join(__dirname, ...up, 'package.json'), 'utf8')) as { version: string }).version;
    } catch { /* try the next layout */ }
  }
  return '0.0.0';
})();

/**
 * The folder Claude Code files a workspace's sessions under: every character
 * but ASCII letters and digits as `-`, one per code point, nothing collapsed.
 */
export function projectFolder(cwd: string): string {
  return cwd ? cwd.replace(/[^a-zA-Z0-9]/gu, '-') : 'no-workspace';
}

/** The branch checked out in the repository holding `cwd`; "HEAD" when detached, undefined outside one. */
export async function gitBranch(cwd: string): Promise<string | undefined> {
  for (let dir = path.resolve(cwd || '/'); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    const stat = await fs.stat(dotGit).catch(() => undefined);
    if (stat) {
      // A worktree or submodule has a file pointing at its git folder.
      const gitDir = stat.isDirectory()
        ? dotGit
        : path.resolve(dir, (await fs.readFile(dotGit, 'utf8').catch(() => '')).replace(/^gitdir:\s*/, '').trim());
      const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => '')).trim();
      if (!head) { return undefined; }
      return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : 'HEAD';
    }
    if (path.dirname(dir) === dir) { return undefined; }
  }
}

type Line = Record<string, unknown> & { type?: string; uuid?: string; timestamp?: string };
type Usage = { input_tokens: number; output_tokens: number };

const usageOf = (input = 0, output = 0): Usage => ({ input_tokens: input, output_tokens: output });
const messageId = (): string => `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
const callId = (): string => `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
const titleOf = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 90) || '(empty)';

export class SessionStore {
  private id: string = randomUUID();
  /** The last line written, which the next one follows. */
  private parent: string | null = null;
  private titled = false;
  private branch?: string;
  /** Set by the turn's prompt, for the lines that follow it. */
  private turn?: { model?: string; title: string; looped: boolean; finalUsage?: Usage };
  /** Tool calls asked for and not yet answered, oldest first. */
  private pending: string[] = [];
  /** Writes in order: a loop's events fire without waiting for the one before. */
  private writing: Promise<void> = Promise.resolve();
  private listeners: Array<(id: string, title?: string) => void> = [];

  /**
   * `base` holds one folder per workspace; `workspace` is read each time, so
   * a host whose workspace can change keeps sessions apart.
   */
  constructor(
    private readonly base: string,
    private readonly workspace: () => string,
    private readonly log: Log,
  ) {}

  get sessionId(): string { return this.id; }

  /** Called with the session id whenever it changes, and with the title once it has one. */
  onChange(listener: (id: string, title?: string) => void): void {
    this.listeners.push(listener);
  }

  /** Where this workspace's sessions are kept. */
  folder(): string {
    return path.join(this.base, projectFolder(this.workspace()));
  }

  private file(id: string): string {
    return path.join(this.folder(), `${id}.jsonl`);
  }

  /** Starts a new session. Nothing is written until its first prompt. */
  startNew(): void {
    this.id = randomUUID();
    this.parent = null;
    this.titled = false;
    this.turn = undefined;
    this.pending = [];
    this.changed();
  }

  /** Records a question as it is sent; the lines of its run follow it. */
  async prompt(p: PromptRecord): Promise<void> {
    this.branch = await gitBranch(this.workspace());
    this.turn = { model: p.model, title: titleOf(p.display ?? p.content), looped: false };
    this.pending = [];
    const typed = p.display === undefined || p.display === p.content;
    this.write({
      type: 'user',
      ...(typed ? { origin: { kind: 'human' } } : {}),
      message: { role: 'user', content: p.content },
      display: typed ? undefined : p.display,
      mode: p.mode, model: p.model, sources: p.sources?.length ? p.sources : undefined, contextChars: p.contextChars || undefined,
    });
    return this.flushed();
  }

  /**
   * A tool loop's events, recording each model reply that asks for tools and
   * each tool's result as they happen. The reply that asks for none is the
   * answer, written by `answer`.
   */
  record(events: AgentEvents): AgentEvents {
    return {
      ...events,
      onReply: (reply) => { events.onReply?.(reply); this.reply(reply); },
      onStep: (step) => { events.onStep(step); this.toolResult(step); },
    };
  }

  private reply(r: ModelReply): void {
    const usage = usageOf(r.promptTokens, r.replyTokens);
    if (this.turn) { this.turn.looped = true; }
    if (!r.toolCalls.length) {
      if (this.turn) { this.turn.finalUsage = usage; }
      return;
    }
    const calls = r.toolCalls.map((c) => ({
      type: 'tool_use', id: c.id || callId(), name: c.function?.name ?? '(unnamed)', input: c.function?.arguments ?? {},
    }));
    this.pending.push(...calls.map((c) => c.id));
    const text = r.content.trim() ? [{ type: 'text', text: r.content }] : [];
    this.write({
      type: 'assistant',
      message: { id: messageId(), type: 'message', role: 'assistant', model: this.turn?.model, content: [...text, ...calls], usage },
    });
  }

  private toolResult(step: AgentStep): void {
    this.write({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: this.pending.shift() ?? callId(), content: step.result, is_error: !step.ok }],
      },
      toolUseResult: { tool: step.tool, ok: step.ok, ms: step.ms },
    });
  }

  /**
   * Records the reply that closes the turn, and titles the session after its
   * first. In a tool loop its usage is the final model reply's; the others
   * are on their own lines already.
   */
  async answer(a: AnswerRecord): Promise<void> {
    const usage = this.turn?.looped ? this.turn.finalUsage : usageOf(a.promptTokens, a.replyTokens);
    this.write({
      type: 'assistant',
      message: {
        id: messageId(), type: 'message', role: 'assistant', model: a.model,
        content: [{ type: 'text', text: a.content }], ...(usage ? { usage } : {}),
      },
      turnEnd: true,
      mode: a.mode, model: a.model, promptTokens: a.promptTokens, replyTokens: a.replyTokens,
      ms: a.ms, steps: a.steps, staged: a.staged,
    });
    // Titled after its first answered question, as the history lists always showed it.
    const title = this.turn?.title;
    this.turn = undefined;
    if (!this.titled && title) {
      this.titled = true;
      this.write({ type: 'ai-title', aiTitle: title }, false);
      this.changed(title);
    }
    return this.flushed();
  }

  /** Resolves when every line asked for so far is on disk. */
  flushed(): Promise<void> {
    return this.writing;
  }

  /** Appends one line, following the last. `chained` is false for lines Claude Code writes outside the chain. */
  private write(fields: Line, chained = true): void {
    const id = this.id;
    const file = this.file(id);
    const line: Line = chained
      ? {
        parentUuid: this.parent, isSidechain: false, ...fields,
        uuid: randomUUID(), timestamp: new Date().toISOString(),
        sessionId: id, cwd: this.workspace(), gitBranch: this.branch, version: VERSION, userType: 'external',
      }
      : { ...fields, sessionId: id };
    if (chained) { this.parent = line.uuid as string; }
    const text = JSON.stringify(line) + '\n';
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, text, 'utf8');
      } catch (err) {
        this.log.appendLine(`[sessions] could not save: ${(err as Error).message}`);
      }
    });
  }

  /** This workspace's sessions, most recently updated first. */
  async list(): Promise<SessionSummary[]> {
    await this.flushed();
    const names = await fs.readdir(this.folder()).catch(() => [] as string[]);
    const out: SessionSummary[] = [];
    for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
      const summary = await this.summarise(name.replace(/\.jsonl$/, ''));
      if (summary) { out.push(summary); }
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /**
   * One line of the history picker; undefined for a session with no turns,
   * such as one opened and left: there is nothing in it to go back to.
   */
  private async summarise(id: string): Promise<SessionSummary | undefined> {
    const lines = await this.read(id);
    const turns = turnsOf(lines);
    if (!turns.length) { return undefined; }

    const asked = turns.filter((t) => t.role === 'user');
    const bytes = await fs.stat(this.file(id)).then((s) => s.size, () => 0);
    return {
      id,
      created: lines.find((l) => l.timestamp)?.timestamp ?? turns[0].at,
      updated: turns[turns.length - 1].at,
      turns: asked.length,
      title: titleOfLines(lines) ?? titleOf(asked[0].display ?? asked[0].content),
      bytes,
    };
  }

  private async read(id: string): Promise<Line[]> {
    return parseLines(await fs.readFile(this.file(id), 'utf8').catch(() => ''));
  }

  /** Whether this workspace has a session `id`, with at least one turn. */
  async has(id: string): Promise<boolean> {
    return turnsOf(await this.read(id)).length > 0;
  }

  /** Loads a session as the active one and returns its turns for replay; none when it is missing. */
  async resume(id: string): Promise<TurnRecord[]> {
    await this.flushed();
    const lines = await this.read(id);
    const turns = turnsOf(lines);
    if (!turns.length) { return []; }
    this.id = id;
    this.parent = [...lines].reverse().find((l) => l.uuid)?.uuid ?? null;
    const title = titleOfLines(lines);
    this.titled = title !== undefined;
    this.turn = undefined;
    this.pending = [];
    this.changed(title);
    return turns;
  }

  async mostRecent(): Promise<SessionSummary | undefined> {
    return (await this.list())[0];
  }

  async delete(id: string): Promise<void> {
    try {
      await this.flushed();
      await fs.rm(this.file(id));
      if (this.id === id) { this.startNew(); }
    } catch (err) {
      this.log.appendLine(`[sessions] could not delete: ${(err as Error).message}`);
    }
  }

  private changed(title?: string): void {
    for (const l of this.listeners) { l(this.id, title); }
  }
}

/** Every JSON object in a transcript, skipping blank and torn lines. */
function parseLines(raw: string): Line[] {
  const out: Line[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) { continue; }
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) { out.push(value as Line); }
    } catch { /* a torn line */ }
  }
  return out;
}

/** The latest `ai-title`, as Claude Code's readers take it. */
function titleOfLines(lines: Line[]): string | undefined {
  const titled = lines.filter((l) => l.type === 'ai-title' && typeof l.aiTitle === 'string');
  return titled.length ? titled[titled.length - 1].aiTitle as string : undefined;
}

/**
 * The finished turns of a transcript: each prompt with the reply that closed
 * it. A prompt whose run was stopped or failed has none, and is left out, as
 * it was left out of the thread.
 */
export function turnsOf(lines: Line[]): TurnRecord[] {
  const out: TurnRecord[] = [];
  let asked: TurnRecord | undefined;
  for (const l of lines) {
    const message = l.message as { content?: unknown } | undefined;
    const at = l.timestamp ?? '';
    if (l.type === 'user' && typeof message?.content === 'string' && !l.toolUseResult) {
      asked = {
        role: 'user', content: message.content, display: l.display as string | undefined, at,
        mode: (l.mode as Mode) ?? 'chat', model: l.model as string | undefined,
        sources: l.sources as string[] | undefined, contextChars: l.contextChars as number | undefined,
      };
    } else if (l.type === 'assistant' && l.turnEnd && asked) {
      const blocks = Array.isArray(message?.content) ? message.content as Array<{ type?: string; text?: string }> : [];
      out.push(asked, {
        role: 'assistant', content: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''), at,
        mode: (l.mode as Mode) ?? asked.mode, model: l.model as string | undefined,
        promptTokens: l.promptTokens as number | undefined, replyTokens: l.replyTokens as number | undefined,
        ms: l.ms as number | undefined, steps: l.steps as number | undefined, staged: l.staged as string | undefined,
      });
      asked = undefined;
    }
  }
  return out;
}

/** An old session's lines: a `meta` line, then `turn` lines. */
interface OldRecord {
  type: 'meta' | 'turn';
  workspace?: string;
  role?: 'user' | 'assistant';
  content?: string;
  at?: string;
  [key: string]: unknown;
}

/**
 * Converts sessions kept before transcripts took Claude Code's shape
 * (`<from>/<slug>/<id>.jsonl`) into `<to>/<folder>/<uuid>.jsonl`, never over
 * a file already there. The new id is derived from the old one, so a
 * conversion cut short and run again finds its own file rather than making a
 * second. Converted files and emptied folders are removed, so a second call
 * finds nothing; one that can't be converted stays and is logged. Returns how
 * many were converted.
 */
export async function convertSessions(from: string, to: string, log: Log): Promise<number> {
  let converted = 0;
  for (const slug of await fs.readdir(from).catch(() => [] as string[])) {
    const src = path.join(from, slug);
    if (!(await fs.stat(src).then((s) => s.isDirectory(), () => false))) { continue; }
    for (const name of (await fs.readdir(src).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl'))) {
      try {
        if (await convertOne(path.join(src, name), to)) { converted++; }
      } catch (err) {
        log.appendLine(`[sessions] could not convert ${path.join(slug, name)}: ${(err as Error).message}`);
      }
    }
    await fs.rmdir(src).catch(() => undefined); // only when emptied
  }
  return converted;
}

/** Converts one old session; false when it held no turns and was simply removed. */
async function convertOne(file: string, to: string): Promise<boolean> {
  const records = parseLines(await fs.readFile(file, 'utf8')) as OldRecord[];
  if (records.some((r) => r.type !== 'meta' && r.type !== 'turn')) { throw new Error('not an old-format session'); }
  const turns = records.filter((r) => r.type === 'turn');
  if (!turns.length) {
    await fs.rm(file); // opened and left: nothing to keep
    return false;
  }
  const workspace = records.find((r) => r.type === 'meta')?.workspace;
  if (typeof workspace !== 'string') { throw new Error('no workspace recorded'); }

  const oldId = path.basename(file, '.jsonl');
  const id = uuidFrom(`${workspace}\0${oldId}`);
  const target = path.join(to, projectFolder(workspace), `${id}.jsonl`);
  const lines = convertedLines(turns, id, workspace);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
  const last = Date.parse(turns[turns.length - 1].at ?? '');
  if (!Number.isNaN(last)) { await fs.utimes(target, new Date(last), new Date(last)); }
  await fs.rm(file);
  return true;
}

/** An old session's turns as transcript lines. It never recorded tool calls, only how many ran. */
function convertedLines(turns: OldRecord[], sessionId: string, cwd: string): Line[] {
  const lines: Line[] = [];
  let parent: string | null = null;
  let titled = false;
  let asked: OldRecord | undefined;
  for (const t of turns) {
    const { type: _type, role, content = '', at, display, ...extra } = t;
    const uuid = uuidFrom(`${sessionId}\0${lines.length}`);
    const common = { parentUuid: parent, isSidechain: false, uuid, timestamp: at, sessionId, cwd, version: VERSION, userType: 'external' };
    if (role === 'user') {
      const typed = display === undefined || display === content;
      lines.push({ ...common, type: 'user', ...(typed ? { origin: { kind: 'human' } } : {}), message: { role: 'user', content }, display, ...extra });
      asked = t;
    } else {
      const { promptTokens, replyTokens } = extra as { promptTokens?: number; replyTokens?: number };
      lines.push({
        ...common, type: 'assistant',
        message: {
          id: `msg_${uuid.replace(/-/g, '').slice(0, 24)}`, type: 'message', role: 'assistant', model: extra.model,
          content: [{ type: 'text', text: content }], usage: usageOf(promptTokens, replyTokens),
        },
        turnEnd: true, ...extra,
      });
      if (!titled && asked) {
        lines.push({ type: 'ai-title', aiTitle: titleOf((asked.display as string | undefined) ?? asked.content ?? ''), sessionId });
        titled = true;
      }
    }
    parent = uuid;
  }
  return lines;
}

/** A UUID derived from `seed`, in the version-5 layout. */
function uuidFrom(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
