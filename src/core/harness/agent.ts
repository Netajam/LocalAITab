import { chatWithTools, getCapabilities, OllamaError, ToolCall, ToolChatResult } from '../llm/ollama';
import { TOOL_SCHEMAS, LOAD_SKILL_SCHEMA, runTool, ToolRunContext, StagedEdit, SkillLoader, Workspace, Log } from './tools';

export const AGENT_SYSTEM_PROMPT = [
  'You are a coding agent working inside the user\'s workspace.',
  '',
  'Locate code before you change it: search first, read only the files you need.',
  'Do not guess at file contents you have not read.',
  '',
  'To change code, call insert_change. Its search text must appear exactly once in the',
  'file, so include surrounding lines when a snippet would otherwise be ambiguous.',
  'insert_change does not write anything: it stages the change for the user to approve.',
  '',
  'When a change is staged, or when the question is answered, stop calling tools and',
  'reply with one or two sentences describing what you did. Do not repeat a tool call',
  'that already succeeded.',
].join('\n');

export interface AgentStep {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
  ms: number;
}

export interface AgentEvents {
  onStep: (step: AgentStep) => void;
  onThinking: (step: number, max: number) => void;
  /** Fired before a tool runs, so a slow search or read is visible while it happens. */
  onToolStart?: (tool: string, args: Record<string, unknown>) => void;
  /** Fired with each model reply, before any tool it asks for runs. */
  onReply?: (reply: ModelReply) => void;
}

/** A model reply as the loop's events see it. */
export type ModelReply = Pick<ToolChatResult, 'content' | 'toolCalls' | 'promptTokens' | 'replyTokens'>;

export interface AgentOutcome {
  answer: string;
  steps: AgentStep[];
  staged?: StagedEdit;
  /** True when the loop was stopped by the cap rather than by the model. */
  hitCap: boolean;
  promptTokens: number;
  replyTokens: number;
  totalMs: number;
  aborted: boolean;
}

export interface AgentRunOptions {
  endpoint: string;
  model: string;
  maxSteps: number;
  temperature: number;
  maxTokens: number;
  keepAlive: string;
  /** Absolute path of the workspace folder. */
  root: string;
  workspace: Workspace;
  maxReadChars: number;
  maxSearchLines: number;
  signal: AbortSignal;
  contextBlock?: string;
  history?: unknown[];
  /** The skills the model may load, one line each, appended to the system prompt. */
  skillCatalog?: string;
  /** Backs load_skill; the tool is only offered when this is set. */
  loadSkill?: SkillLoader;
  /** Folders outside the workspace the user granted to the agent. */
  extraRoots?: string[];
}

/**
 * The agent loop.
 *
 * Bounded by maxSteps, which is a hard stop rather than a hint: the cap is the
 * only thing standing between a confused model and an unbounded number of
 * requests. Read-only tools run unattended; insert_change only ever stages.
 */
export async function runAgent(
  question: string,
  opts: AgentRunOptions,
  events: AgentEvents,
  output: Log,
): Promise<AgentOutcome> {
  const run = await startRun(question, opts);

  for (let i = 0; i < opts.maxSteps; i++) {
    if (opts.signal.aborted) { return outcome(run, true); }

    events.onThinking(i + 1, opts.maxSteps);

    const res = await requestTurn(opts, run);
    if (!res) { return outcome(run, true); }
    if (await applyTurn(run, res, events, output)) { break; }
  }

  if (run.hitCap) {
    output.appendLine(`[agent] stopped at the ${opts.maxSteps} step cap`);
  }

  return outcome(run, false);
}

/** Everything one agent run accumulates between turns. */
interface AgentRun {
  started: number;
  messages: unknown[];
  tools: unknown;
  think: boolean | undefined;
  ctx: ToolRunContext;
  steps: AgentStep[];
  answer: string;
  promptTokens: number;
  replyTokens: number;
  hitCap: boolean;
}

async function startRun(question: string, opts: AgentRunOptions): Promise<AgentRun> {
  const started = Date.now();
  const messages = openingMessages(question, opts);
  const tools = opts.loadSkill ? [...TOOL_SCHEMAS, LOAD_SKILL_SCHEMA] : TOOL_SCHEMAS;
  const ctx = toolContext(opts);

  const caps = await getCapabilities(opts.endpoint, opts.model);
  const think = caps.includes('thinking') ? false : undefined;

  return { started, messages, tools, think, ctx, steps: [], answer: '', promptTokens: 0, replyTokens: 0, hitCap: true };
}

function outcome(run: AgentRun, aborted: boolean): AgentOutcome {
  return {
    answer: run.answer,
    steps: run.steps,
    staged: run.ctx.staged,
    hitCap: !aborted && run.hitCap,
    promptTokens: run.promptTokens,
    replyTokens: run.replyTokens,
    totalMs: Date.now() - run.started,
    aborted,
  };
}

/**
 * Folds one model reply into the run: either its final answer, or the tool
 * calls it asked for, run in order. Returns true when the model answered.
 */
async function applyTurn(
  run: AgentRun,
  res: ToolChatResult,
  events: AgentEvents,
  output: Log,
): Promise<boolean> {
  run.promptTokens = res.promptTokens || run.promptTokens;
  run.replyTokens += res.replyTokens;
  events.onReply?.(res);

  if (!res.toolCalls.length) {
    run.answer = res.content.trim();
    run.hitCap = false;
    return true;
  }

  // The assistant turn carrying the tool calls has to go back verbatim, or
  // the model loses track of what it already asked for.
  run.messages.push(res.raw);

  for (const call of res.toolCalls) {
    const step = await runStep(call, run.ctx, run.steps.length + 1, events, output);
    run.steps.push(step);
    run.messages.push({ role: 'tool', content: step.result });
  }
  return false;
}

function openingMessages(question: string, opts: AgentRunOptions): unknown[] {
  const system = [
    AGENT_SYSTEM_PROMPT, renderRoots(opts.root, opts.extraRoots ?? []), opts.skillCatalog ?? '', opts.contextBlock ?? '',
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: system },
    ...(opts.history ?? []),
    { role: 'user', content: question },
  ];
}

function toolContext(opts: AgentRunOptions): ToolRunContext {
  return {
    root: opts.root,
    workspace: opts.workspace,
    maxReadChars: opts.maxReadChars,
    maxSearchLines: opts.maxSearchLines,
    loadSkill: opts.loadSkill,
    extraRoots: opts.extraRoots,
  };
}

/** One model turn. Resolves to undefined when the request failed because the user stopped it. */
async function requestTurn(opts: AgentRunOptions, run: AgentRun): Promise<ToolChatResult | undefined> {
  try {
    return await chatWithTools({
      endpoint: opts.endpoint,
      model: opts.model,
      messages: run.messages,
      tools: run.tools,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      keepAlive: opts.keepAlive,
      signal: opts.signal,
      think: run.think,
    });
  } catch (err) {
    if (opts.signal.aborted) { return undefined; }
    throw err instanceof OllamaError ? err : new OllamaError((err as Error).message);
  }
}

/** Runs one tool call, reports it and logs it. */
async function runStep(
  call: ToolCall,
  ctx: ToolRunContext,
  index: number,
  events: AgentEvents,
  output: Log,
): Promise<AgentStep> {
  const t0 = Date.now();
  const name = call.function?.name ?? '(unnamed)';
  const args = (call.function?.arguments ?? {}) as Record<string, unknown>;

  events.onToolStart?.(name, args);
  const result = await runTool(name, args, ctx);
  const step: AgentStep = { index, tool: name, args, result: result.text, ok: result.ok, ms: Date.now() - t0 };
  events.onStep(step);

  output.appendLine(
    `[agent] step ${step.index} ${name}(${JSON.stringify(args).slice(0, 120)}) ` +
    `-> ${result.ok ? 'ok' : 'error'} ${step.ms}ms`,
  );
  return step;
}

/**
 * Tells the model where it may go beyond the workspace. Without this it has
 * no way to know an extra folder exists, let alone its path.
 */
function renderRoots(root: string, extra: string[]): string {
  if (!extra.length) { return ''; }
  return [
    `The workspace is ${root}. The user also granted these folders outside it;`,
    'reach them by absolute path with read_file, search (its path argument) and insert_change:',
    ...extra.map((p) => `- ${p}`),
  ].join('\n');
}
