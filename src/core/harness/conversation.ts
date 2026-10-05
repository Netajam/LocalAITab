import { ChatMessage, listModels, chatStream, getCapabilities, OllamaError } from '../llm/ollama';
import { runAgent, AgentEvents, AgentOutcome, AgentRunOptions } from './agent';
import { runOperator, OperatorRunOptions, OperatorOutcome, WRITE_OVERRIDE } from './operator/operator';
import { Skill, DEFAULT_SKILL_PATHS, loadSkills, skillRoots, agentSkills, expandSkill } from './skills/skills';

/**
 * One conversation with the model, whoever hosts it.
 *
 * This is the harness's front door. A host (the editor, the terminal) supplies
 * how files are reached, how a command gets approved and where logs go; the
 * conversation keeps the thread, knows the skills, and runs a turn in the
 * mode asked for. Everything a host shows the user stays on the host's side.
 */

export type Mode = 'chat' | 'agent' | 'operator';
export type LoopMode = Exclude<Mode, 'chat'>;

/** What a turn reads, named like the extension's localAITab.* settings. */
export interface Settings {
  endpoint: string;
  model: string;
  keepAlive: string;
  chatMaxTokens: number;
  chatTemperature: number;
  chatHistoryTurns: number;
  agentMaxSteps: number;
  agentTemperature: number;
  agentMaxReadChars: number;
  agentMaxSearchLines: number;
  operatorMaxSteps: number;
  operatorTemperature: number;
  operatorMaxOutputChars: number;
  /** Seconds. */
  operatorCommandTimeout: number;
}

/** What a host supplies. */
export interface ConversationHost {
  /** How the loops read and write files. */
  workspace: AgentRunOptions['workspace'];
  /** Asked before an operator command runs. */
  approve: OperatorRunOptions['approve'];
  log: { appendLine(line: string): void };
  /** Read at the start of every turn, so a changed setting applies to the next one. */
  settings(): Settings;
}

/** Where a turn runs and who hears about its progress. */
export interface Turn {
  /** Absolute path of the workspace folder. */
  root: string;
  /** Folders beyond it the agent may read; operator mode stays in the workspace. */
  extraRoots?: string[];
  /** Attached context, rendered for the system prompt. */
  contextBlock?: string;
  signal: AbortSignal;
  events: AgentEvents;
}

/** A chat turn: no tools, the answer streamed to the host as it arrives. */
export interface ChatTurn {
  contextBlock?: string;
  signal: AbortSignal;
  onToken(delta: string): void;
}

export interface ChatResult {
  answer: string;
  promptTokens: number;
  replyTokens: number;
  totalMs: number;
  /** True when the user stopped it; `answer` holds what had arrived by then. */
  aborted: boolean;
}

/** Chat mode's instructions. General questions are answered from what the model knows. */
export const CHAT_SYSTEM_PROMPT = [
  'You are a knowledgeable software engineering assistant, answering in the user\'s terminal.',
  'Answer questions directly from your own knowledge. Be concise, and use fenced code blocks',
  'with a language tag for any code.',
].join('\n');

/**
 * Added only when files are attached. Telling the model to stay within
 * attached context when there is none makes it refuse general questions,
 * or invent a context to refuse from.
 */
const ATTACHED_CONTEXT_RULE = [
  'The user attached the files below. When the question is about them, ground your answer in',
  'them, and say which file or symbol you would need rather than guessing at code you were not',
  'given. Questions that are not about them you answer from your own knowledge as usual.',
].join('\n');

/** A change agent mode proposes, for the host to show and apply on approval. */
export type StagedChange = NonNullable<AgentOutcome['staged']>;

/**
 * How a turn ended. `note` is what it left in the thread: the answer plus what
 * changed, or nothing when the run produced neither.
 */
export type TurnResult =
  | (AgentOutcome & { mode: 'agent'; note: string })
  | (OperatorOutcome & { mode: 'operator'; note: string });

export class Conversation {
  private thread: ChatMessage[] = [];
  private loaded: Skill[] = [];

  constructor(private readonly host: ConversationHost) {}

  /** Earlier questions and answers, oldest first. */
  get history(): readonly ChatMessage[] {
    return this.thread;
  }

  /** The models the endpoint has installed, for picking one. */
  models(): Promise<string[]> {
    return listModels(this.host.settings().endpoint);
  }

  /** Every skill found, including ones only the model may invoke. */
  get skills(): readonly Skill[] {
    return this.loaded;
  }

  /**
   * Adds a question and its answer. Only these carry over between turns: a
   * loop's tool traffic would fill the window within a few turns, and its
   * conclusions are what matter later.
   */
  remember(question: string, answer: string): void {
    this.thread.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    this.trim();
  }

  /** Takes over a saved thread, as far as the history setting allows. */
  resume(messages: ChatMessage[]): void {
    this.thread = messages.map((m) => ({ role: m.role, content: m.content }));
    this.trim();
  }

  clear(): void {
    this.thread = [];
  }

  /**
   * Rescans the skill folders. Relative paths sit in `workspace`. Returns the
   * SKILL.md files skipped, and why.
   */
  async loadSkills(paths: string[] = DEFAULT_SKILL_PATHS, workspace?: string): Promise<string[]> {
    const { skills, problems } = await loadSkills(skillRoots(paths, workspace));
    this.loaded = skills;
    return problems;
  }

  /** The skills a user may run by name. */
  invocableSkills(): Skill[] {
    return this.loaded.filter((s) => s.userInvocable);
  }

  /**
   * What `/name args` sends in `mode`, or undefined when no such skill can be
   * run by hand. Tool modes also learn which files the skill bundles.
   */
  skillPrompt(name: string, args: string, mode: Mode): string | undefined {
    const skill = this.invocableSkills().find((s) => s.name === name);
    return skill && expandSkill(skill, args, mode !== 'chat', mode === 'operator' ? WRITE_OVERRIDE : '');
  }

  /**
   * Answers in one streamed reply, without tools. The attached context rides
   * in the system message, and the question and answer join the thread, so
   * switching to a tool mode afterwards keeps the conversation.
   */
  async chat(question: string, turn: ChatTurn): Promise<ChatResult> {
    const s = this.host.settings();
    const started = Date.now();
    const system = turn.contextBlock
      ? `${CHAT_SYSTEM_PROMPT}\n\n${ATTACHED_CONTEXT_RULE}\n\n${turn.contextBlock}`
      : CHAT_SYSTEM_PROMPT;
    let answer = '';
    try {
      // Thinking models spend the whole budget reasoning unless told not to.
      const think = (await getCapabilities(s.endpoint, s.model)).includes('thinking') ? false : undefined;
      const res = await chatStream({
        endpoint: s.endpoint, model: s.model, temperature: s.chatTemperature, maxTokens: s.chatMaxTokens,
        keepAlive: s.keepAlive, signal: turn.signal, think,
        messages: [{ role: 'system', content: system }, ...this.thread, { role: 'user', content: question }],
        onToken: (delta) => { answer += delta; turn.onToken(delta); },
      });
      if (res.text.trim()) { this.remember(question, res.text); }
      return { answer: res.text, promptTokens: res.promptEvalCount ?? 0, replyTokens: res.evalCount, totalMs: Date.now() - started, aborted: false };
    } catch (err) {
      if (!turn.signal.aborted) { throw err instanceof OllamaError ? err : new OllamaError((err as Error).message); }
      return { answer, promptTokens: 0, replyTokens: 0, totalMs: Date.now() - started, aborted: true };
    }
  }

  /** Runs one task through a tool loop and keeps the thread in step with what it did. */
  async run(mode: LoopMode, task: string, turn: Turn): Promise<TurnResult> {
    const result = mode === 'operator'
      ? await this.runOperator(task, turn)
      : await this.runAgent(task, turn);
    if (result.note) { this.remember(task, result.note); }
    return result;
  }

  private async runAgent(task: string, turn: Turn): Promise<TurnResult> {
    const s = this.host.settings();
    const outcome = await runAgent(task, {
      ...this.loopBase(s, turn),
      maxSteps: s.agentMaxSteps,
      temperature: s.agentTemperature,
      extraRoots: (turn.extraRoots ?? []).filter((p) => p !== turn.root),
    }, turn.events, this.host.log);

    const staged = outcome.staged ? `\n(staged a change to ${outcome.staged.path} for review)` : '';
    const note = outcome.answer || staged ? outcome.answer + staged : '';
    return { ...outcome, mode: 'agent', note };
  }

  private async runOperator(task: string, turn: Turn): Promise<TurnResult> {
    const s = this.host.settings();
    const outcome = await runOperator(task, {
      ...this.loopBase(s, turn),
      approve: this.host.approve,
      maxSteps: s.operatorMaxSteps,
      temperature: s.operatorTemperature,
      maxOutputChars: s.operatorMaxOutputChars,
      timeoutMs: s.operatorCommandTimeout * 1000,
    }, turn.events, this.host.log);

    const changed = outcome.changed.length ? `\n(changed ${outcome.changed.join(', ')})` : '';
    const note = outcome.answer || changed ? outcome.answer + changed : '';
    return { ...outcome, mode: 'operator', note };
  }

  /** What both loops are handed. */
  private loopBase(s: Settings, turn: Turn) {
    return {
      endpoint: s.endpoint,
      model: s.model,
      maxTokens: s.chatMaxTokens,
      keepAlive: s.keepAlive,
      root: turn.root,
      workspace: this.host.workspace,
      maxReadChars: s.agentMaxReadChars,
      maxSearchLines: s.agentMaxSearchLines,
      signal: turn.signal,
      contextBlock: turn.contextBlock || undefined,
      history: [...this.thread],
      ...agentSkills(this.loaded),
    };
  }

  /** Keeps the thread from growing past what the model can hold. */
  private trim(): void {
    const max = this.host.settings().chatHistoryTurns * 2;
    if (this.thread.length > max) { this.thread = this.thread.slice(this.thread.length - max); }
  }
}
