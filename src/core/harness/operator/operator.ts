import { chatWithTools, getCapabilities, OllamaError } from '../../llm/ollama';
import { SkillLoader, Workspace, Log } from '../tools';
import { OPERATOR_TOOL_SCHEMAS, LOAD_SKILL_SCHEMA, runOperatorTool, OperatorToolContext, Approve } from './tools';

/** Appended to a skill run in operator mode, and repeated in its system prompt. */
export const WRITE_OVERRIDE = [
  'You can create and change files yourself with write_file and edit_file, and run commands',
  'with run_command. Where the instructions above say you cannot create files, or tell you to',
  'reply with a file\'s content for the user to save, write the file yourself instead, then',
  'reply with a short summary rather than the content.',
].join('\n');

export const OPERATOR_SYSTEM_PROMPT = [
  'You are an autonomous coding agent working inside the user\'s workspace, with',
  'a shell. Carry the task through to the end: investigate, change the code, then verify',
  'by running the build or the tests.',
  '',
  'Locate code before you change it: search first, read only the files you need.',
  'Do not guess at file contents you have not read.',
  '',
  'edit_file and write_file change files immediately. Keep edits small and targeted.',
  'run_command runs one non-interactive shell command in the workspace root; the user',
  'approves each one. If a command is declined, do not retry it.',
  'Never run destructive commands (rm -rf, git reset --hard, force pushes) unless the',
  'user explicitly asked for them.',
  '',
  'Skills may have been written for a mode without these tools; load_skill output included.',
  WRITE_OVERRIDE,
  '',
  'When the task is done, stop calling tools and reply with a short summary of what you',
  'changed and how you verified it.',
].join('\n');

export interface OperatorStep {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
  ms: number;
}

export interface OperatorEvents {
  onStep: (step: OperatorStep) => void;
  onThinking: (step: number, max: number) => void;
  onToolStart?: (tool: string, args: Record<string, unknown>) => void;
  onReply?: (reply: ModelReply) => void;
}

export interface OperatorOutcome {
  answer: string;
  steps: OperatorStep[];
  /** Workspace-relative paths the run wrote to. */
  changed: string[];
  hitCap: boolean;
  promptTokens: number;
  replyTokens: number;
  totalMs: number;
  aborted: boolean;
}

export interface OperatorRunOptions {
  endpoint: string;
  model: string;
  maxSteps: number;
  temperature: number;
  maxTokens: number;
  keepAlive: string;
  /** Absolute path of the workspace folder. */
  root: string;
  workspace: Workspace;
  /** Asked before every command, unless it answered "all" earlier in the run. */
  approve: Approve;
  maxReadChars: number;
  maxSearchLines: number;
  maxOutputChars: number;
  timeoutMs: number;
  signal: AbortSignal;
  contextBlock?: string;
  history?: unknown[];
  skillCatalog?: string;
  loadSkill?: SkillLoader;
}

/**
 * The operator loop. Same shape as agent mode's, kept separate so the two
 * modes can evolve apart: this one writes and runs things, and its cap is
 * sized for build-and-fix cycles rather than a single staged change.
 */
export async function runOperator(
  task: string,
  opts: OperatorRunOptions,
  events: OperatorEvents,
  output: Log,
): Promise<OperatorOutcome> {
  const started = Date.now();
  const messages = openingMessages(task, opts);
  const ctx = toolContext(opts, output);
  // Filled in as the loop runs, so an abort at any point can return it as is.
  const run = { answer: '', steps: [] as OperatorStep[], promptTokens: 0, replyTokens: 0 };
  const finish = (end: 'answered' | 'capped' | 'aborted'): OperatorOutcome => ({
    ...run,
    changed: [...ctx.changed],
    hitCap: end === 'capped',
    totalMs: Date.now() - started,
    aborted: end === 'aborted',
  });

  for (let i = 0; i < opts.maxSteps; i++) {
    if (opts.signal.aborted) { return finish('aborted'); }
    events.onThinking(i + 1, opts.maxSteps);

    const res = await askModel(opts, messages);
    if (!res) { return finish('aborted'); }
    run.promptTokens = res.promptTokens || run.promptTokens;
    run.replyTokens += res.replyTokens;
    events.onReply?.(res);

    if (!res.toolCalls.length) {
      run.answer = res.content.trim();
      return finish('answered');
    }

    // The assistant turn carrying the tool calls has to go back verbatim, or
    // the model loses track of what it already asked for.
    messages.push(res.raw);
    for (const call of res.toolCalls) {
      if (opts.signal.aborted) { return finish('aborted'); }
      const step = await runStep(call, run.steps.length + 1, ctx, events);
      run.steps.push(step);
      messages.push({ role: 'tool', content: step.result });
    }
  }

  output.appendLine(`[operator] stopped at the ${opts.maxSteps} step cap`);
  return finish('capped');
}

type ModelReply = Awaited<ReturnType<typeof chatWithTools>>;
type ToolCall = ModelReply['toolCalls'][number];

/** One model turn. Undefined means the user stopped the run mid-request. */
async function askModel(opts: OperatorRunOptions, messages: unknown[]): Promise<ModelReply | undefined> {
  // Cached per model, so asking every turn costs nothing after the first.
  const caps = await getCapabilities(opts.endpoint, opts.model);
  try {
    return await chatWithTools({
      endpoint: opts.endpoint,
      model: opts.model,
      messages,
      tools: opts.loadSkill ? [...OPERATOR_TOOL_SCHEMAS, LOAD_SKILL_SCHEMA] : OPERATOR_TOOL_SCHEMAS,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      keepAlive: opts.keepAlive,
      signal: opts.signal,
      think: caps.includes('thinking') ? false : undefined,
    });
  } catch (err) {
    if (opts.signal.aborted) { return undefined; }
    throw err instanceof OllamaError ? err : new OllamaError((err as Error).message);
  }
}

async function runStep(call: ToolCall, index: number, ctx: OperatorToolContext, events: OperatorEvents): Promise<OperatorStep> {
  const t0 = Date.now();
  const tool = call.function?.name ?? '(unnamed)';
  const args = (call.function?.arguments ?? {}) as Record<string, unknown>;

  events.onToolStart?.(tool, args);
  const result = await runOperatorTool(tool, args, ctx);
  const step: OperatorStep = { index, tool, args, result: result.text, ok: result.ok, ms: Date.now() - t0 };
  events.onStep(step);

  ctx.output.appendLine(
    `[operator] step ${index} ${tool}(${JSON.stringify(args).slice(0, 120)}) ` +
    `-> ${result.ok ? 'ok' : 'error'} ${step.ms}ms`,
  );
  return step;
}

function openingMessages(task: string, opts: OperatorRunOptions): unknown[] {
  const system = [OPERATOR_SYSTEM_PROMPT, opts.skillCatalog ?? '', opts.contextBlock ?? ''].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    ...(opts.history ?? []),
    { role: 'user', content: task },
  ];
}

function toolContext(opts: OperatorRunOptions, output: Log): OperatorToolContext {
  return {
    root: opts.root,
    workspace: opts.workspace,
    approve: opts.approve,
    maxReadChars: opts.maxReadChars,
    maxSearchLines: opts.maxSearchLines,
    maxOutputChars: opts.maxOutputChars,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    output,
    loadSkill: opts.loadSkill,
    changed: new Set(),
  };
}
