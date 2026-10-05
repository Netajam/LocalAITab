import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { chat, getCapabilities } from '../../../core/llm/ollama';
import { cleanCode } from '../../../core/llm/extract';

const exec = promisify(execFile);

/**
 * Search planning: the model proposes ripgrep queries, the user decides which
 * results are worth reading.
 *
 * This is deliberately not a relevance classifier. Formulating queries -- trying
 * casings, synonyms, narrowing globs -- is the tedious part and the model is good
 * at it. Judging which of a handful of hits matters is the part a human does
 * better, and doing it by hand is what keeps irrelevant code out of the prompt.
 */

export interface PlannedQuery {
  pattern: string;
  glob?: string;
  ignoreCase?: boolean;
  why?: string;
}

export interface Hit {
  line: number;
  text: string;
}

export interface FileHits {
  path: string;
  uri: vscode.Uri;
  hits: Hit[];
}

export interface PlanOutcome {
  queries: PlannedQuery[];
  files: FileHits[];
  totalHits: number;
  /** Queries that returned nothing, shown so a bad plan is visible rather than silent. */
  emptyQueries: string[];
  ms: number;
}

const PLAN_SYSTEM = [
  'You plan code searches. Given a task, emit ripgrep queries that will surface the relevant code.',
  '',
  'Reply ONLY with JSON, no prose and no code fences:',
  '{"queries":[{"pattern":"<regex>","glob":"<optional file filter>","ignoreCase":true|false,"why":"<short reason>"}]}',
  '',
  'Rules:',
  '- Between 2 and 5 queries, most specific first.',
  '- Patterns are regular expressions, not shell commands. Never put ripgrep flags in a pattern.',
  '- Strongly prefer identifiers that already exist in the codebase, listed below.',
  '  Inventing a name in a convention this codebase does not use returns nothing.',
].join('\n');

/**
 * A cheap local description of the codebase: its files and the identifiers it
 * actually defines. Without this the model guesses conventions and misses --
 * it proposed Go-style names for a TypeScript project and returned zero hits.
 */
export async function buildSketch(
  root: vscode.Uri,
  maxSymbols: number,
  globs: string,
): Promise<{ files: string[]; extensions: string[]; symbols: string[] }> {
  const rel = (p: string) => p.replace(root.fsPath + '/', '');

  let files: string[] = [];
  try {
    const { stdout } = await exec('rg', ['--files', '-g', globs, root.fsPath], { maxBuffer: 4 << 20 });
    files = stdout.split('\n').filter(Boolean).map(rel).slice(0, 400);
  } catch { /* an empty sketch still beats no sketch */ }

  let symbols: string[] = [];
  try {
    const { stdout } = await exec('rg', [
      '-o', '-N', '--no-filename', '-g', globs, '-r', '$1',
      '(?:export )?(?:async )?(?:function|const|class|interface|type|enum|def|fn|struct) (\\w{3,})',
      root.fsPath,
    ], { maxBuffer: 4 << 20 });
    symbols = [...new Set(stdout.split('\n').filter(Boolean))].slice(0, maxSymbols);
  } catch { /* ditto */ }

  const extensions = [...new Set(files.map((f) => f.split('.').pop() ?? ''))].filter(Boolean);
  return { files, extensions, symbols };
}

export async function planQueries(opts: {
  task: string;
  endpoint: string;
  model: string;
  temperature: number;
  keepAlive: string;
  signal: AbortSignal;
  sketch: { files: string[]; extensions: string[]; symbols: string[] };
}): Promise<PlannedQuery[]> {
  const { sketch } = opts;
  const system = [
    PLAN_SYSTEM,
    '',
    `Files (${sketch.files.length}): ${sketch.files.slice(0, 200).join(', ')}`,
    `Extensions: ${sketch.extensions.join(', ')}`,
    'Identifiers defined in this codebase:',
    sketch.symbols.join(', '),
  ].join('\n');

  const caps = await getCapabilities(opts.endpoint, opts.model);
  const res = await chat({
    endpoint: opts.endpoint,
    model: opts.model,
    system,
    user: opts.task,
    temperature: opts.temperature,
    maxTokens: 700,
    keepAlive: opts.keepAlive,
    signal: opts.signal,
    think: caps.includes('thinking') ? false : undefined,
  });

  let parsed: { queries?: PlannedQuery[] };
  try {
    parsed = JSON.parse(cleanCode(res.text));
  } catch {
    throw new Error(`the model did not return a usable plan: ${res.text.slice(0, 160)}`);
  }

  return (parsed.queries ?? [])
    .filter((q) => typeof q.pattern === 'string' && q.pattern.trim())
    .slice(0, 6);
}

/**
 * Runs a plan locally. Flags are never taken from the model: only the pattern,
 * an optional validated glob and a case-sensitivity bit are honoured, and
 * execFile is used rather than a shell so the pattern cannot inject arguments.
 */
export async function runPlan(opts: {
  queries: PlannedQuery[];
  root: vscode.Uri;
  defaultGlobs: string;
  contextLines: number;
  maxHitsPerFile: number;
  maxFiles: number;
}): Promise<PlanOutcome> {
  const started = Date.now();
  const byFile = new Map<string, Map<number, string>>();
  const emptyQueries: string[] = [];

  for (const q of opts.queries) {
    const lines = await ripgrep(q, opts);
    if (!lines.length) { emptyQueries.push(q.pattern); continue; }
    for (const raw of lines) { recordHit(byFile, raw, opts); }
  }

  const files = toFileHits(byFile, opts.root);
  return {
    queries: opts.queries,
    files,
    totalHits: files.reduce((n, f) => n + f.hits.length, 0),
    emptyQueries,
    ms: Date.now() - started,
  };
}

/** Runs one planned query and returns its raw `path:line:text` lines. */
async function ripgrep(
  q: PlannedQuery,
  opts: { root: vscode.Uri; defaultGlobs: string; maxHitsPerFile: number },
): Promise<string[]> {
  const args = ['-n', '--no-heading', '--max-count', String(opts.maxHitsPerFile), '--max-filesize', '1M'];
  if (q.ignoreCase) { args.push('-i'); }

  const glob = q.glob && /^[\w.*/{},[\]-]+$/.test(q.glob) ? q.glob : opts.defaultGlobs;
  args.push('-g', glob, '--', q.pattern, opts.root.fsPath);

  try {
    const { stdout } = await exec('rg', args, { maxBuffer: 8 << 20 });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return []; // rg exits non-zero on no matches
  }
}

/** Files a single rg line under its path, unless it would open a file past the cap. */
function recordHit(
  byFile: Map<string, Map<number, string>>,
  raw: string,
  opts: { root: vscode.Uri; maxFiles: number },
): void {
  const m = raw.replace(opts.root.fsPath + '/', '').match(/^(.+?):(\d+):([\s\S]*)$/);
  if (!m) { return; }
  const [, path, lineNo, text] = m;

  let hits = byFile.get(path);
  if (!hits) {
    if (byFile.size >= opts.maxFiles) { return; }
    hits = new Map();
    byFile.set(path, hits);
  }
  hits.set(Number(lineNo), text);
}

function toFileHits(byFile: Map<string, Map<number, string>>, root: vscode.Uri): FileHits[] {
  return [...byFile.entries()]
    .map(([path, hits]) => ({
      path,
      uri: vscode.Uri.joinPath(root, path),
      hits: [...hits.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([line, text]) => ({ line, text })),
    }))
    // Most hits first: a rough relevance order the user can override at a glance.
    .sort((a, b) => b.hits.length - a.hits.length);
}

/** What the user ticked: whole files, and individual hit lines. */
export interface PlanSelection {
  wholeFiles: string[];
  lines: Array<{ path: string; line: number }>;
}

/**
 * Turns a selection into context text. Line picks are expanded by a few lines
 * either side and merged where they overlap, so a chosen hit arrives with enough
 * surrounding code to be readable rather than as a bare line.
 */
export async function materialise(
  selection: PlanSelection,
  root: vscode.Uri,
  contextLines: number,
): Promise<Array<{ label: string; path: string; text: string; language: string }>> {
  const out: Array<{ label: string; path: string; text: string; language: string }> = [];

  for (const path of selection.wholeFiles) {
    const doc = await openIfPossible(vscode.Uri.joinPath(root, path));
    if (doc) { out.push({ label: 'Search hit (whole file)', path, text: doc.getText(), language: doc.languageId }); }
  }

  const grouped = new Map<string, number[]>();
  for (const { path, line } of selection.lines) {
    if (selection.wholeFiles.includes(path)) { continue; } // already sent in full
    grouped.set(path, [...(grouped.get(path) ?? []), line]);
  }

  for (const [path, lineNos] of grouped) {
    const doc = await openIfPossible(vscode.Uri.joinPath(root, path));
    if (!doc) { continue; }

    const all = doc.getText().split('\n');
    const text = mergeRanges(lineNos, contextLines, all.length)
      .map(([from, to]) => `// lines ${from}-${to}\n${all.slice(from - 1, to).join('\n')}`)
      .join('\n\n// ...\n\n');

    out.push({
      label: `Search hits (${lineNos.length} line${lineNos.length > 1 ? 's' : ''})`,
      path,
      text,
      language: doc.languageId,
    });
  }
  return out;
}

/**
 * 1-based inclusive line ranges covering each line number plus `context` lines
 * either side, clamped to the file, with overlapping or touching ranges merged.
 */
function mergeRanges(lineNos: number[], context: number, lineCount: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const n of [...lineNos].sort((a, b) => a - b)) {
    const from = Math.max(1, n - context);
    const to = Math.min(lineCount, n + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) { last[1] = Math.max(last[1], to); }
    else { ranges.push([from, to]); }
  }
  return ranges;
}

async function openIfPossible(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}
