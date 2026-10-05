/**
 * Qwen2.5-Coder fill-in-the-middle prompt assembly and response cleanup.
 *
 * Repo-level FIM layout (per the Qwen2.5-Coder model card):
 *   <|repo_name|>NAME
 *   <|file_sep|>path/a.ts
 *   ...contents...
 *   <|file_sep|>path/current.ts
 *   <|fim_prefix|>BEFORE<|fim_suffix|>AFTER<|fim_middle|>
 */

export const TOK = {
  prefix: '<|fim_prefix|>',
  suffix: '<|fim_suffix|>',
  middle: '<|fim_middle|>',
  pad: '<|fim_pad|>',
  repo: '<|repo_name|>',
  file: '<|file_sep|>',
  eot: '<|endoftext|>',
} as const;

/** Anything that would mean the model has left the completion region. */
export const STOP_TOKENS = [TOK.eot, TOK.pad, TOK.file, TOK.prefix, TOK.suffix, TOK.middle, TOK.repo];

const ALL_TOKENS = Object.values(TOK);

export interface NeighborFile {
  path: string;
  text: string;
}

export interface PromptInput {
  prefix: string;
  suffix: string;
  filePath: string;
  repoName?: string;
  neighbors?: NeighborFile[];
}

export function buildPrompt(input: PromptInput): string {
  const parts: string[] = [];

  if (input.repoName) {
    parts.push(`${TOK.repo}${input.repoName}\n`);
  }
  for (const n of input.neighbors ?? []) {
    parts.push(`${TOK.file}${n.path}\n${n.text}\n`);
  }
  // The current file comes last so the cursor sits at the end of the prompt.
  if (input.repoName || (input.neighbors && input.neighbors.length)) {
    parts.push(`${TOK.file}${input.filePath}\n`);
  }
  parts.push(`${TOK.prefix}${input.prefix}${TOK.suffix}${input.suffix}${TOK.middle}`);

  return parts.join('');
}

/**
 * Multi-line completions are offered when nothing but whitespace and closing
 * brackets follow the cursor on its line. Plain "rest of line is empty" is too
 * strict: the usual place to type in a braces language is just above an already
 * present `}` or `})`, and those positions want a whole block. Anything with
 * real code after the cursor stays single-line, since completing into the middle
 * of a live expression nearly always needs manual cleanup afterwards.
 */
export function shouldBeMultiline(lineSuffix: string, mode: string): boolean {
  if (mode === 'always') { return true; }
  if (mode === 'never') { return false; }
  return /^[\s)\]}]*$/.test(lineSuffix);
}

/**
 * True when `s` is the kind of text that is safe to strip as a duplicate of the
 * suffix: a line break, or nothing but closers/whitespace. Without this guard a
 * completion of `x = 1` against a suffix of `1 + 2` would lose its trailing `1`.
 */
function isStructuralOverlap(s: string): boolean {
  if (s.length === 0) { return false; }
  return /\n/.test(s) || /^[\s)\]}>;,]+$/.test(s);
}

/** Drop a trailing run of the completion that merely restates the start of the suffix. */
export function trimSuffixOverlap(out: string, suffix: string): string {
  if (!out || !suffix) { return out; }

  const variants = [suffix, suffix.replace(/^[ \t]*\r?\n/, '')];
  let best = 0;

  for (const variant of variants) {
    const max = Math.min(out.length, variant.length);
    for (let k = max; k > best; k--) {
      const candidate = variant.slice(0, k);
      if (out.endsWith(candidate) && isStructuralOverlap(candidate)) {
        best = k;
        break;
      }
    }
  }
  return best > 0 ? out.slice(0, out.length - best) : out;
}

export interface CleanOptions {
  suffix: string;
  multiline: boolean;
}

export function postProcess(raw: string, opts: CleanOptions): string {
  let out = raw;

  // Strip any control tokens the sampler emitted before a stop sequence caught them.
  for (const t of ALL_TOKENS) {
    if (out.includes(t)) { out = out.split(t).join(''); }
  }
  if (!out) { return ''; }

  if (!opts.multiline) {
    const nl = out.indexOf('\n');
    if (nl !== -1) { out = out.slice(0, nl); }
    out = out.replace(/\s+$/, '');
  } else {
    // A run of blank lines at the tail is the model drifting, not content.
    out = out.replace(/(\r?\n){3,}$/, '\n');
  }

  out = trimSuffixOverlap(out, opts.suffix);

  // Whitespace-only suggestions are noise -- VS Code renders them as a phantom cursor jump.
  if (!out.trim()) { return ''; }

  return out;
}
