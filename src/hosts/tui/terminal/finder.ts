import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The fuzzy finder behind `@`: every file and folder in the workspace, ranked
 * against what has been typed so far.
 *
 * The index comes from `rg --files --hidden`, so .gitignore is honoured and
 * dotfiles are in, and folders are the ones those files sit in. Hidden entries
 * list after the rest, so they do not crowd an empty query. A query starting with `~` or `/` browses the
 * disk instead, one folder at a time, for context from outside the workspace.
 */

export interface Entry {
  /** Relative to the workspace, or absolute (with ~) outside it. Folders end in `/`. */
  path: string;
  dir: boolean;
}

export interface Match {
  entry: Entry;
  score: number;
  /** Indexes into entry.path of the characters that matched, for highlighting. */
  positions: number[];
}

const MAX_ENTRIES = 50000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '__pycache__', '.venv', 'vendor']);

/** Files and folders under `root`: folders first, hidden ones after the rest, each by path. */
export async function indexPaths(root: string): Promise<Entry[]> {
  const files = await ripgrepFiles(root).catch(() => walk(root));
  const dirs = new Set<string>();
  for (const f of files) {
    for (let at = f.indexOf('/'); at >= 0; at = f.indexOf('/', at + 1)) { dirs.add(f.slice(0, at + 1)); }
  }
  return [
    ...[...dirs].sort(byVisibility).map((p) => ({ path: p, dir: true })),
    ...files.sort(byVisibility).map((p) => ({ path: p, dir: false })),
  ];
}

function ripgrepFiles(root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('rg', ['--files', '--hidden', '--no-messages', '-g', '!.git/'], { cwd: root, maxBuffer: 64 << 20 }, (err, stdout) => {
      // rg exits 1 when it finds no files at all, which is an answer, not a failure.
      if (err && (err as { code?: unknown }).code !== 1) { reject(err); return; }
      resolve(stdout.split('\n').filter(Boolean).slice(0, MAX_ENTRIES));
    });
  });
}

/** Without ripgrep: a plain walk that skips version control, dependencies and build output. */
async function walk(root: string, rel = '', out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) { break; }
    if (SKIP_DIRS.has(e.name)) { continue; }
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { await walk(root, p, out); } else if (e.isFile()) { out.push(p); }
  }
  return out;
}

/** True when a query names a place on disk rather than filtering the workspace. */
export function browsesDisk(query: string): boolean {
  return query.startsWith('~') || query.startsWith('/');
}

/**
 * The entries of the folder a query points into, for ranking against what
 * follows its last slash: `~/no` lists the home folder. A relative query is
 * read from `base`; its entries keep the query's own spelling.
 */
export async function browse(query: string, base = process.cwd()): Promise<Entry[]> {
  const slash = query.lastIndexOf('/');
  const folder = slash >= 0 ? query.slice(0, slash + 1) : browsesDisk(query) ? query + '/' : '';
  const abs = path.resolve(base, folder.replace(/^~(?=\/|$)/, os.homedir()) || '.');
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
  return entries
    .map((e) => ({ path: folder + e.name + (e.isDirectory() ? '/' : ''), dir: e.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || byVisibility(a.path, b.path));
}

/** Visible paths before hidden ones (any segment starting with a dot), then by path. */
function byVisibility(a: string, b: string): number {
  const hidden = (p: string) => /(^|\/)\.[^/]/.test(p.replace(/^~\//, '')) ? 1 : 0;
  return hidden(a) - hidden(b) || a.localeCompare(b);
}

/**
 * The best `limit` entries for `query`. Every query character must appear in
 * order; runs of consecutive matches, matches at the start of a path segment
 * or a word, and matches in the file name score higher, and shorter paths win
 * ties. An empty query lists the top of the tree.
 */
export function rank(query: string, entries: Entry[], limit: number): Match[] {
  if (!query) {
    return entries
      .filter((e) => !e.path.slice(0, -1).includes('/'))
      .slice(0, limit)
      .map((entry) => ({ entry, score: 0, positions: [] }));
  }
  const matches: Match[] = [];
  for (const entry of entries) {
    const m = score(query, entry.path);
    if (m) { matches.push({ entry, ...m }); }
  }
  return matches
    .sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit);
}

/**
 * How well `query` matches `target`, case-insensitively unless the query has
 * a capital. Several alignments are tried (the query as one run, first and
 * last; greedy from either end) and the best scoring one kept.
 */
export function score(query: string, target: string): { score: number; positions: number[] } | undefined {
  const smart = query !== query.toLowerCase();
  const q = smart ? query : query.toLowerCase();
  const t = smart ? target : target.toLowerCase();

  const candidates: number[][] = [];
  for (const at of [t.lastIndexOf(q), t.indexOf(q)]) {
    if (at >= 0) { candidates.push([...q].map((_, i) => at + i)); }
  }
  const left = greedy(q, t, 1);
  if (!left) { return undefined; }
  candidates.push(left, greedy(q, t, -1)!);

  let best: { score: number; positions: number[] } | undefined;
  for (const positions of candidates) {
    const s = alignmentScore(target, positions);
    if (!best || s > best.score) { best = { score: s, positions }; }
  }
  return best;
}

/** Each query character at its first (dir 1) or last (dir -1) place that keeps the order. */
function greedy(q: string, t: string, dir: 1 | -1): number[] | undefined {
  const out: number[] = [];
  let ti = dir === 1 ? 0 : t.length - 1;
  for (let k = 0; k < q.length; k++) {
    const ch = dir === 1 ? q[k] : q[q.length - 1 - k];
    while (ti >= 0 && ti < t.length && t[ti] !== ch) { ti += dir; }
    if (ti < 0 || ti >= t.length) { return undefined; }
    out.push(ti);
    ti += dir;
  }
  return dir === 1 ? out : out.reverse();
}

/**
 * Runs of consecutive matches, matches at the start of a path segment or a
 * word, and matches in the file name score higher; long paths score a little
 * lower.
 */
function alignmentScore(target: string, positions: number[]): number {
  const nameStart = target.slice(0, -1).lastIndexOf('/') + 1;
  let s = 0;
  positions.forEach((p, i) => {
    s += 1 + boundaryBonus(target, p) + (p >= nameStart ? 2 : 0);
    if (i > 0 && positions[i - 1] === p - 1) { s += 5; }
  });
  return s - target.length * 0.05;
}

/** A match that starts a path segment, a word after a separator, or a camelCase hump. */
function boundaryBonus(target: string, p: number): number {
  const before = target[p - 1];
  if (p === 0 || before === '/') { return 8; }
  if ('_-. '.includes(before)) { return 6; }
  return /[a-z]/.test(before) && /[A-Z]/.test(target[p]) ? 6 : 0;
}
