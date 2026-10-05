import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';

const exec = promisify(execFile);

/**
 * The tools the agent mode exposes.
 *
 * search and read_file are read-only and run without asking, as does
 * load_skill below. insert_change never writes: it stages a
 * change for the human to approve, in whatever review the host offers. That asymmetry is the whole safety model, so keep it.
 */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'search',
      description:
        'Search the workspace with ripgrep. Returns matching lines as file:line:text. ' +
        'Use this to locate code before reading whole files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for.' },
          glob: { type: 'string', description: 'Optional file filter, e.g. "*.ts".' },
          path: {
            type: 'string',
            description: 'Optional folder or file to search instead of the whole workspace. ' +
              'Also the way to search an extra folder listed in the system prompt, by its absolute path.',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative path, or an absolute path inside an extra folder listed in the system prompt.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_change',
      description:
        'Propose an edit for human review. The search text must appear EXACTLY ONCE in the ' +
        'file; include surrounding lines if needed to make it unique. This does not write to ' +
        'disk, it stages the change for the user to accept or reject.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path, or absolute inside an extra folder.' },
          search: { type: 'string', description: 'Exact existing text, copied character for character.' },
          replace: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'search', 'replace'],
      },
    },
  },
] as const;

/**
 * Offered only when there are skills to load, so a workspace without any does
 * not spend prompt on a tool the model can never use. Read-only, like search.
 */
export const LOAD_SKILL_SCHEMA = {
  type: 'function',
  function: {
    name: 'load_skill',
    description:
      'Load the instructions of a skill listed in the system prompt. Leave file out; pass it ' +
      'only to read a file the instructions list as bundled.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, as listed.' },
        file: { type: 'string', description: 'Only a file named in the loaded instructions.' },
      },
      required: ['name'],
    },
  },
} as const;

export interface StagedEdit {
  /** Absolute path of the file the change is in. */
  file: string;
  /** The same file as the user would write it. */
  path: string;
  /** Offset of `before` in the file as it was read. */
  at: number;
  before: string;
  after: string;
}

export interface ToolRunContext {
  /** Absolute path of the workspace folder. */
  root: string;
  workspace: Workspace;
  maxReadChars: number;
  maxSearchLines: number;
  /** Folders outside the workspace the user granted; reachable by absolute path. */
  extraRoots?: string[];
  /**
   * Backs load_skill. Injected rather than imported, so the tools know nothing
   * about where skills live.
   */
  loadSkill?: SkillLoader;
  /** Set once a change is staged; a run stages at most one. */
  staged?: StagedEdit;
}

export type SkillLoader = (name: string, file: string, maxChars: number) => Promise<ToolResult>;

/**
 * How the tools reach file contents, injected like the skill loader.
 *
 * Everything else they do (ripgrep, listing folders, running commands)
 * happens on disk whoever hosts them. Reading and writing is the part a host
 * may want to route elsewhere: an editor answers reads from its unsaved
 * buffers and sends writes through its undo stack.
 */
export interface Workspace {
  /** The text of a file as the user currently sees it. */
  read(file: string): Promise<string>;
  /** Replaces `length` characters at `at` with `text`, and saves. */
  replace(file: string, at: number, length: number, text: string): Promise<void>;
  /** Creates or overwrites a file, creating its folder when needed. */
  write(file: string, content: string): Promise<void>;
}

/** Where the loops log. A VS Code output channel is one as it stands. */
export interface Log {
  appendLine(line: string): void;
}

export interface ToolResult {
  text: string;
  /** False when the model should treat this as a correctable mistake. */
  ok: boolean;
}

type Tool = (args: Record<string, unknown>, ctx: ToolRunContext) => Promise<ToolResult>;

// A Map rather than an object literal, so a name like "toString" is not a tool.
const TOOLS = new Map<string, Tool>([
  ['search', toolSearch],
  ['read_file', toolRead],
  ['insert_change', toolInsert],
  ['load_skill', toolLoadSkill],
]);

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolRunContext,
): Promise<ToolResult> {
  const tool = TOOLS.get(name);
  if (!tool) { return { ok: false, text: `ERROR: no tool named "${name}".` }; }
  try {
    return await tool(args, ctx);
  } catch (err) {
    return { ok: false, text: `ERROR: ${(err as Error).message.split('\n')[0]}` };
  }
}

async function toolSearch(args: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
  const pattern = String(args.pattern ?? '');
  if (!pattern) { return { ok: false, text: 'ERROR: pattern is required.' }; }

  const target = args.path ? resolveReachable(String(args.path), ctx) : ctx.root;
  if (!target) { return unreachable(String(args.path), ctx); }

  const glob = args.glob ? ['-g', String(args.glob)] : [];
  const rgArgs = ['-n', '--no-heading', '--max-count', '5', '--max-filesize', '1M', ...glob, '--', pattern, target];

  let stdout: string;
  try {
    ({ stdout } = await exec('rg', rgArgs, { maxBuffer: 4 << 20 }));
  } catch (err) {
    return searchFailure(err);
  }
  const lines = stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(ctx.root + '/', ''))
    .slice(0, ctx.maxSearchLines);
  return { ok: true, text: lines.join('\n') || '(no matches)' };
}

/** ripgrep exits 1 with no output when nothing matched; that is not an error. */
function searchFailure(err: unknown): ToolResult {
  const e = err as { code?: unknown; stdout?: string; message?: string };
  if (e.code === 1 && !e.stdout) { return { ok: true, text: '(no matches)' }; }
  // A missing binary fails the spawn with "spawn rg ENOENT".
  const message = e.message ?? 'search failed';
  if (/ENOENT/.test(message)) {
    return { ok: false, text: 'ERROR: ripgrep (rg) is not installed or not on PATH.' };
  }
  return { ok: false, text: `ERROR: ${message.split('\n')[0]}` };
}

async function toolRead(args: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
  const p = String(args.path ?? '');
  const file = resolveReachable(p, ctx);
  if (!file) { return unreachable(p, ctx); }

  const listing = await listIfFolder(file);
  if (listing) { return listing; }

  const text = await ctx.workspace.read(file);

  if (text.length > ctx.maxReadChars) {
    return {
      ok: true,
      text:
        text.slice(0, ctx.maxReadChars) +
        `\n\n[truncated at ${ctx.maxReadChars} of ${text.length} chars; use search to find the part you need]`,
    };
  }
  return { ok: true, text };
}

async function toolLoadSkill(args: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
  if (!ctx.loadSkill) { return { ok: false, text: 'ERROR: there are no skills to load.' }; }
  return ctx.loadSkill(String(args.name ?? '').replace(/^\//, ''), String(args.file ?? ''), ctx.maxReadChars);
}

/**
 * Models often read a folder to see what is in it. Answering that beats an
 * EISDIR error, which costs a step of the capped loop.
 */
async function listIfFolder(folder: string): Promise<ToolResult | undefined> {
  const stat = await fs.stat(folder).catch(() => undefined);
  if (!stat?.isDirectory()) { return undefined; }

  const names = (await fs.readdir(folder, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
    .sort();
  return { ok: true, text: `${folder} is a folder containing:\n${names.join('\n') || '(nothing)'}` };
}

async function toolInsert(args: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
  if (ctx.staged) {
    return {
      ok: false,
      text: 'ERROR: a change is already staged for review. Summarise and stop; the user applies one change at a time.',
    };
  }

  const p = String(args.path ?? '');
  const file = resolveReachable(p, ctx);
  if (!file) { return unreachable(p, ctx); }

  const search = String(args.search ?? '');
  const found = await locateOnce(ctx.workspace, file, search, args.path);
  if ('text' in found) { return found; }

  ctx.staged = {
    file,
    path: shownPath(file, ctx.root),
    at: found.at,
    before: search,
    after: String(args.replace ?? ''),
  };

  return { ok: true, text: 'OK: change staged for the user to review. Summarise what you did and stop.' };
}

/**
 * Where the search text sits in the file, or the correctable error when it
 * does not appear exactly once. The dangerous failure is not "no match" but
 * "matched the wrong one", so a non-unique search is rejected too.
 */
export async function locateOnce(
  workspace: Workspace,
  file: string,
  search: string,
  asWritten: unknown,
): Promise<{ at: number } | ToolResult> {
  if (!search) { return { ok: false, text: 'ERROR: search text is required.' }; }

  const text = await workspace.read(file);
  const hits = text.split(search).length - 1;
  if (hits === 0) {
    return { ok: false, text: 'ERROR: search text not found. Copy it exactly from the file, including indentation.' };
  }
  if (hits > 1) {
    return {
      ok: false,
      text: `ERROR: search text matches ${hits} places in ${asWritten}. Include surrounding lines to make it unique.`,
    };
  }

  return { at: text.indexOf(search) };
}

/**
 * Resolves a model-supplied path, rejecting anything outside the workspace.
 *
 * Models write paths three ways: relative ("src/a.ts"), rooted at the workspace
 * ("/src/a.ts"), and genuinely absolute ("/Users/me/proj/src/a.ts"). The first
 * two are the same thing; the third is only acceptable when it lands inside the
 * workspace. Both are normalised before the check, and "/ws/../etc" starts with
 * "/ws/" until it is, so traversal cannot escape.
 */
export function resolveInWorkspace(rel: string, root: string): string | undefined {
  if (!rel.trim()) { return undefined; }

  const candidates: string[] = [];
  if (rel.startsWith('/')) {
    candidates.push(path.resolve(rel));                         // truly absolute
    candidates.push(path.join(root, rel.replace(/^\/+/, '')));  // rooted at workspace
  } else {
    candidates.push(path.join(root, rel));
  }

  const rootPath = root.endsWith('/') ? root : root + '/';
  return candidates.find((c) => c === root || c.startsWith(rootPath));
}

/**
 * What the agent may read or stage an edit in: an absolute path (~ allowed)
 * inside a folder the user granted, or else whatever resolveInWorkspace
 * accepts. Grants are checked first because resolveInWorkspace reads any
 * absolute path as rooted at the workspace. It stays workspace-only, for
 * callers that must not reach further.
 */
function resolveReachable(p: string, ctx: ToolRunContext): string | undefined {
  const t = p.trim().replace(/^~(?=\/|$)/, os.homedir());
  if (path.isAbsolute(t)) {
    const abs = path.resolve(t);
    const granted = (ctx.extraRoots ?? []).some((r) => abs === r || abs.startsWith(r + path.sep));
    if (granted) { return abs; }
  }
  return resolveInWorkspace(p, ctx.root);
}

/** A path as the user would write it: relative inside the workspace, absolute outside it. */
export function shownPath(file: string, root: string): string {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

/** The error for a path out of reach, naming what is reachable so the model can correct itself. */
function unreachable(p: string, ctx: ToolRunContext): ToolResult {
  const extra = ctx.extraRoots ?? [];
  return {
    ok: false,
    text: `ERROR: ${p || 'path'} is outside the workspace` +
      (extra.length ? ` and outside the extra folders (${extra.join(', ')}).` : '. No extra folders are granted.'),
  };
}
