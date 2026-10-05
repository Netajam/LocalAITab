import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import {
  TOOL_SCHEMAS, LOAD_SKILL_SCHEMA, runTool, resolveInWorkspace, locateOnce, shownPath, SkillLoader, ToolResult, Workspace, Log,
} from '../tools';

/**
 * The tools operator mode exposes.
 *
 * Operator mode trades agent mode's "nothing changes without a diff" for reach:
 * file edits land directly, and the model can run shell commands. The line it
 * still holds is that every command is shown to the user before it runs, since
 * a command reaches past the workspace and a file write does not. Reads and
 * writes stay confined to the workspace; git is the undo.
 */

const READ_ONLY = TOOL_SCHEMAS.filter((t) => t.function.name !== 'insert_change');

export const OPERATOR_TOOL_SCHEMAS = [
  ...READ_ONLY,
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a workspace file with the given content. Writes immediately. ' +
        'Prefer edit_file for changing part of an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path.' },
          content: { type: 'string', description: 'The full new content of the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace text in a workspace file. Writes immediately. The search text must appear ' +
        'EXACTLY ONCE; include surrounding lines if needed to make it unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path.' },
          search: { type: 'string', description: 'Exact existing text, copied character for character.' },
          replace: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace root and return its exit code and combined ' +
        'output. The user approves each command before it runs and may decline. Commands ' +
        'are not interactive: never run anything that waits for input or never exits.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line, run by the user\'s shell.' },
        },
        required: ['command'],
      },
    },
  },
] as const;

export { LOAD_SKILL_SCHEMA };

/**
 * Shows the user a command before it runs. "all" also approves every later
 * command of the same run; undefined declines.
 */
export type Approve = (command: string, cwd: string) => Promise<'once' | 'all' | undefined>;

export interface OperatorToolContext {
  /** Absolute path of the workspace folder. */
  root: string;
  workspace: Workspace;
  approve: Approve;
  maxReadChars: number;
  maxSearchLines: number;
  maxOutputChars: number;
  timeoutMs: number;
  signal: AbortSignal;
  output: Log;
  loadSkill?: SkillLoader;
  /** Set when the user picked "Run all" for this request. */
  approveAll?: boolean;
  /** Workspace-relative paths written during the run, for the summary. */
  changed: Set<string>;
}

type OperatorTool = (args: Record<string, unknown>, ctx: OperatorToolContext) => Promise<ToolResult>;

/** Operator's own tools; any other name falls through to the shared read-only ones. */
const OPERATOR_TOOLS = new Map<string, OperatorTool>([
  ['write_file', toolWrite],
  ['edit_file', toolEdit],
  ['run_command', toolRun],
  ['insert_change', async () => ({ ok: false, text: 'ERROR: no tool named "insert_change"; use edit_file.' })],
]);

export async function runOperatorTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OperatorToolContext,
): Promise<ToolResult> {
  const tool = OPERATOR_TOOLS.get(name);
  try {
    return await (tool ? tool(args, ctx) : runTool(name, args, ctx));
  } catch (err) {
    return { ok: false, text: `ERROR: ${(err as Error).message.split('\n')[0]}` };
  }
}

async function toolWrite(args: Record<string, unknown>, ctx: OperatorToolContext): Promise<ToolResult> {
  const file = resolveInWorkspace(String(args.path ?? ''), ctx.root);
  if (!file) { return { ok: false, text: 'ERROR: path is outside the workspace.' }; }

  const content = String(args.content ?? '');
  await ctx.workspace.write(file, content);

  const rel = shownPath(file, ctx.root);
  ctx.changed.add(rel);
  ctx.output.appendLine(`[operator] wrote ${rel} (${content.length} chars)`);
  return { ok: true, text: `OK: wrote ${rel} (${content.split('\n').length} lines).` };
}

async function toolEdit(args: Record<string, unknown>, ctx: OperatorToolContext): Promise<ToolResult> {
  const file = resolveInWorkspace(String(args.path ?? ''), ctx.root);
  if (!file) { return { ok: false, text: 'ERROR: path is outside the workspace.' }; }

  const search = String(args.search ?? '');
  const found = await locateOnce(ctx.workspace, file, search, args.path);
  if ('text' in found) { return found; }

  await ctx.workspace.replace(file, found.at, search.length, String(args.replace ?? ''));

  const rel = shownPath(file, ctx.root);
  ctx.changed.add(rel);
  ctx.output.appendLine(`[operator] edited ${rel}`);
  return { ok: true, text: `OK: edited ${rel}.` };
}

async function toolRun(args: Record<string, unknown>, ctx: OperatorToolContext): Promise<ToolResult> {
  const command = String(args.command ?? '').trim();
  if (!command) { return { ok: false, text: 'ERROR: command is required.' }; }

  if (!(await approved(command, ctx))) {
    ctx.output.appendLine(`[operator] declined: ${command}`);
    return {
      ok: false,
      text: 'DECLINED: the user did not allow this command. Do not retry it; try another approach or explain what you needed it for.',
    };
  }

  ctx.output.appendLine(`[operator] $ ${command}`);
  const { code, out, timedOut } = await exec(command, ctx);
  ctx.output.appendLine(out);
  ctx.output.appendLine(`[operator] exit ${code}${timedOut ? ' (timed out)' : ''}`);

  const status = timedOut
    ? `TIMED OUT after ${Math.round(ctx.timeoutMs / 1000)}s and was killed`
    : `exit ${code}`;
  return { ok: code === 0 && !timedOut, text: `${status}\n${clip(out, ctx.maxOutputChars) || '(no output)'}` };
}

/** Asks the user before a command runs, unless they approved them all earlier in this request. */
async function approved(command: string, ctx: OperatorToolContext): Promise<boolean> {
  if (ctx.approveAll) { return true; }
  const answer = await ctx.approve(command, ctx.root);
  ctx.approveAll = answer === 'all';
  return answer !== undefined;
}

/**
 * Runs through the user's login shell, so PATH matches their terminal rather
 * than whatever the extension host inherited. stdout and stderr are merged in
 * arrival order, the way a terminal would show them.
 */
function exec(command: string, ctx: OperatorToolContext): Promise<{ code: number; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawnShell(command, ctx.root);

    let out = '';
    let timedOut = false;
    // Hard ceiling on what is buffered; clip() trims to the model's share later.
    const keep = (b: Buffer) => { out = (out + b.toString('utf8')).slice(-4 * ctx.maxOutputChars); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.stdin.end();

    const timer = setTimeout(() => { timedOut = true; killTree(child); }, ctx.timeoutMs);
    const onAbort = () => killTree(child);
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const done = (code: number) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolve({ code, out, timedOut });
    };
    child.on('error', (err) => { out += `\n${err.message}`; done(127); });
    child.on('close', (code) => done(code ?? 1));
  });
}

/** Elsewhere than Windows the shell leads its own process group, so killTree can reach its children. */
function spawnShell(command: string, cwd: string): ChildProcessWithoutNullStreams {
  return process.platform === 'win32'
    ? spawn(command, { cwd, shell: true, windowsHide: true })
    : spawn(process.env.SHELL || '/bin/sh', ['-lc', command], { cwd, detached: true });
}

/** Kills the whole process group, or a shell's children outlive it. */
function killTree(child: ChildProcessWithoutNullStreams): void {
  try {
    if (child.pid && process.platform !== 'win32') { process.kill(-child.pid, 'SIGKILL'); } else { child.kill(); }
  } catch { /* already gone */ }
}

/** Keeps the head and the tail: errors and summaries tend to sit at the end. */
export function clip(text: string, max: number): string {
  const t = text.trimEnd();
  if (t.length <= max) { return t; }
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${t.slice(0, head)}\n[... ${t.length - max} chars omitted ...]\n${t.slice(-tail)}`;
}
