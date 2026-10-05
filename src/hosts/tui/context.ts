import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `@path` in a message attaches that file, or the source files in that folder,
 * as context for the turn. Mentions are relative to the workspace, or absolute
 * (`~` allowed) anywhere else. What is sent is shown before the run starts.
 */

/** `@path`, or `@"path with spaces"`, at the start of the text or after a space. */
const MENTION = /(^|\s)@("([^"]+)"|[^\s"]+)/g;

export function mentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const p = m[3] ?? m[2];
    if (!out.includes(p)) { out.push(p); }
  }
  return out;
}

/** The text a mention of `p` is written as, quoted when it holds a space. */
export function mentionOf(p: string): string {
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}

export interface Attached {
  /** As mentioned. */
  path: string;
  files: number;
  chars: number;
}

export interface Collected {
  /** The block for the system prompt; empty when nothing was attached. */
  block: string;
  attached: Attached[];
  /** Mentions and files left out, and why. */
  skipped: string[];
}

/** Source files worth reading when a folder is attached; keeps binaries and lockfiles out. */
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|rb|php|cs|c|h|cpp|hpp|swift|scala|sh|sql|ya?ml|toml|json|md|txt|html|css|scss|vue|svelte|lua|zig|ex|exs|clj|hs|ml|r|dart|tf|gradle|xml|ini|cfg|conf)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', '.venv']);
const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$/;
const MAX_FOLDER_FILES = 200;

/**
 * Reads what `text` mentions, within `budget` characters in all. Files come
 * in the order mentioned; a folder's files in path order. Past the budget, a
 * file is cut short once and the rest are listed as skipped.
 */
export async function collect(text: string, root: string, budget: number): Promise<Collected> {
  const acc: Accumulator = { root, left: budget, pieces: [], skipped: [] };
  const attached: Attached[] = [];
  for (const mention of mentions(text)) {
    const entry = await attach(mention, acc);
    if (entry.files) { attached.push(entry); }
  }
  return { block: render(acc.pieces), attached, skipped: acc.skipped };
}

/** What collect gathers as it goes, and how much of the budget is left. */
interface Accumulator {
  root: string;
  left: number;
  pieces: Array<{ path: string; text: string }>;
  skipped: string[];
}

/** One mention: a file, or each source file of a folder, as far as the budget goes. */
async function attach(mention: string, acc: Accumulator): Promise<Attached> {
  const entry: Attached = { path: mention, files: 0, chars: 0 };
  const abs = resolve(mention, acc.root);
  const stat = await fs.stat(abs).catch(() => undefined);
  if (!stat) { acc.skipped.push(`${mention} (not found)`); return entry; }

  for (const file of stat.isDirectory() ? await sourceFiles(abs) : [abs]) {
    const shown = shownPath(file, acc.root);
    if (acc.left <= 0) { acc.skipped.push(`${shown} (over the context budget)`); continue; }
    const content = await readText(file);
    // Inside a folder a binary is just passed over; named on its own, it is worth saying.
    if (content === undefined) { if (!stat.isDirectory()) { acc.skipped.push(`${shown} (not text)`); } continue; }
    const cut = content.length > acc.left ? content.slice(0, acc.left) + '\n[... cut at the context budget ...]' : content;
    acc.left -= Math.min(content.length, acc.left);
    acc.pieces.push({ path: shown, text: cut });
    entry.files++;
    entry.chars += cut.length;
  }
  return entry;
}

/** The same shape the chat panel sends, so both hosts' context reads alike to the model. */
function render(pieces: Array<{ path: string; text: string }>): string {
  if (!pieces.length) { return ''; }
  const parts = ['The user has attached the following code as context.', ''];
  for (const p of pieces) {
    parts.push(`--- Attached file: ${p.path} ---`, '```' + language(p.path), p.text, '```', '');
  }
  return parts.join('\n');
}

function resolve(mention: string, root: string): string {
  const p = mention.replace(/^~(?=\/|$)/, os.homedir());
  return path.isAbsolute(p) ? p : path.join(root, p);
}

function shownPath(file: string, root: string): string {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') ? rel : file.replace(os.homedir(), '~');
}

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_FOLDER_FILES) { break; }
    if (SKIP_DIRS.has(e.name)) { continue; }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { await sourceFiles(p, out); }
    else if (SOURCE.test(e.name) && !LOCKFILE.test(p)) { out.push(p); }
  }
  return out;
}

/** The file as text, or undefined for a binary (a NUL byte in its first 8 KB). */
async function readText(file: string): Promise<string | undefined> {
  const buf = await fs.readFile(file).catch(() => undefined);
  if (!buf || buf.subarray(0, 8192).includes(0)) { return undefined; }
  return buf.toString('utf8');
}

function language(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return ({ ts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', rs: 'rust', rb: 'ruby', kt: 'kotlin', sh: 'bash', yml: 'yaml', md: 'markdown' } as Record<string, string>)[ext] ?? ext;
}
