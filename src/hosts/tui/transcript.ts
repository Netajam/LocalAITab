import { SessionStore, TurnRecord, convertSessions } from '../../core/harness/sessions';
import { Mode, ConversationHost, TurnResult, Turn } from '../../core/harness/conversation';

/**
 * The terminal's saved conversations: each turn is written as it happens,
 * the question, every tool call and the answer, and /resume lists and reopens
 * them. The files are the chat panel's, in Claude Code's transcript shape.
 */

/** A question as it was asked: what was sent, what was typed, and what went with it. */
export interface Asked {
  question: string;
  /** What the user typed, when that differs from what was sent: a /skill. */
  display: string;
  mode: Mode;
  model: string;
  sources: string[];
  contextChars: number;
}

/** What came back, as it goes in the file. */
export type Answered = Pick<TurnRecord, 'content' | 'promptTokens' | 'replyTokens' | 'ms' | 'steps' | 'staged'>;

export class Transcript {
  readonly store: SessionStore;
  /** Sessions from before transcripts took Claude Code's shape, converted before anything is read. */
  private readonly converted: Promise<unknown>;

  /** `legacy` is where sessions were kept before; they are converted into `folder` once. */
  constructor(folder: string, workspace: string, log: ConversationHost['log'], legacy?: string) {
    this.store = new SessionStore(folder, () => workspace, log);
    this.converted = legacy ? convertSessions(legacy, folder, log).then((n) => {
      if (n) { log.appendLine(`[sessions] converted ${n} earlier conversation(s) into ${folder}`); }
    }) : Promise.resolve();
  }

  get current(): string { return this.store.sessionId; }

  /** A question, appended as it is sent; the session's file starts with the first. */
  async ask(asked: Asked): Promise<void> {
    await this.converted;
    const { question, display, mode, model, sources, contextChars } = asked;
    await this.store.prompt({ content: question, display, mode, model, sources, contextChars });
  }

  /** A tool loop's events, with each model reply and tool result written as it happens. */
  record(events: Turn['events']): Turn['events'] {
    return this.store.record(events);
  }

  /** The answer that closes the question asked last. */
  async answer(asked: Asked, answered: Answered): Promise<void> {
    await this.store.answer({ mode: asked.mode, model: asked.model, ...answered });
  }

  /** One question and its answer, when there is nothing in between to record. */
  async save(asked: Asked, answered: Answered): Promise<void> {
    await this.ask(asked);
    await this.answer(asked, answered);
  }

  /** Leaves the current session; the next turn starts a new file. */
  startOver(): void { this.store.startNew(); }

  /** Past sessions for the /resume popup: the first question to recognise, the id to insert. */
  async choices(): Promise<Array<{ value: string; label: string; hint: string }>> {
    await this.converted;
    const now = Date.now();
    return (await this.store.list()).map((s) => ({
      value: s.id,
      label: s.title,
      hint: `${ago(s.updated, now)} · ${s.turns} turn${s.turns === 1 ? '' : 's'}${s.id === this.current ? ' · current' : ''}`,
    }));
  }

  /** Whether this folder has a saved conversation `id`. */
  async has(id: string): Promise<boolean> {
    await this.converted;
    return this.store.has(id);
  }

  async latest(): Promise<string | undefined> {
    await this.converted;
    return (await this.store.mostRecent())?.id;
  }

  /** Makes a saved session the current one; its turns, or none when it is gone. */
  async open(id: string): Promise<TurnRecord[]> {
    await this.converted;
    return this.store.resume(id);
  }
}

/** What a tool-loop run leaves in the file, or undefined when it left nothing in the thread. */
export function answeredBy(result: TurnResult): Answered | undefined {
  if (!result.note) { return undefined; }
  return {
    content: result.note, promptTokens: result.promptTokens, replyTokens: result.replyTokens, ms: result.totalMs,
    steps: result.steps.length, staged: result.mode === 'agent' ? result.staged?.path : undefined,
  };
}

/** "just now", "5 min ago", "3 h ago", "yesterday", then the date. */
export function ago(iso: string, now = Date.now()): string {
  const mins = Math.floor((now - Date.parse(iso)) / 60000);
  if (mins < 1) { return 'just now'; }
  if (mins < 60) { return `${mins} min ago`; }
  if (mins < 24 * 60) { return `${Math.floor(mins / 60)} h ago`; }
  if (mins < 48 * 60) { return 'yesterday'; }
  return iso.slice(0, 10);
}
