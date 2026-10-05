import { StagedChange } from '../../core/harness/conversation';

/**
 * How a session looks in the terminal. Colour only when writing to one, and
 * never when NO_COLOR is set.
 */

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
// Each style switches off only itself, so styles nest: bold inside a dim line
// stays dim after the bold ends.
const sgr = (on: string, off: string) => (s: string) => (colour ? `\x1b[${on}m${s}\x1b[${off}m` : s);

export const dim = sgr('2', '22');
export const bold = sgr('1', '22');
export const italic = sgr('3', '23');
export const underline = sgr('4', '24');
export const strike = sgr('9', '29');
export const inverse = sgr('7', '27');
export const red = sgr('31', '39');
export const green = sgr('32', '39');
export const yellow = sgr('33', '39');
export const blue = sgr('34', '39');
export const magenta = sgr('35', '39');
export const cyan = sgr('36', '39');

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Columns a string takes on screen: escape codes take none, wide characters two. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, '')) { w += charWidth(ch); }
  return w;
}

/** Combining marks, the zero-width joiner and variation selectors take no column. */
const ZERO_WIDTH: Array<[number, number]> = [[0, 0], [0x300, 0x36f], [0x200d, 0x200d], [0xfe00, 0xfe0f]];
/** East Asian wide characters and emoji take two. */
const DOUBLE_WIDTH: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
];
const within = (c: number, ranges: Array<[number, number]>) => ranges.some(([lo, hi]) => c >= lo && c <= hi);

export function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (within(c, ZERO_WIDTH)) { return 0; }
  return within(c, DOUBLE_WIDTH) ? 2 : 1;
}

/** Cuts a styled string to `width` columns, keeping its escape codes balanced by a reset. */
export function truncate(s: string, width: number): string {
  if (visibleWidth(s) <= width) { return s; }
  let out = '';
  let w = 0;
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) { out += part; continue; }
    for (const ch of part) {
      const cw = charWidth(ch);
      if (w + cw > width - 1) { return out + '…' + (colour ? '\x1b[0m' : ''); }
      out += ch;
      w += cw;
    }
  }
  return out;
}

/**
 * Cuts a styled string into rows of at most `width` columns, wherever the
 * width runs out. Each row after the first starts with the style codes seen so
 * far, so a colour carries across the cut.
 */
export function hardWrap(s: string, width: number): string[] {
  if (visibleWidth(s) <= width) { return [s]; }
  const rows: string[] = [];
  let row = '';
  let w = 0;
  let codes = '';
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) { row += part; codes += part; continue; }
    for (const ch of part) {
      const cw = charWidth(ch);
      if (w + cw > width) {
        rows.push(row + (codes ? '\x1b[0m' : ''));
        row = codes;
        w = 0;
      }
      row += ch;
      w += cw;
    }
  }
  rows.push(row);
  return rows;
}

/**
 * Word-wraps a styled string to `width` columns. Continuation lines start with
 * `indent`, so a list item's text stays clear of its bullet.
 */
export function wrap(s: string, width: number, indent = ''): string[] {
  const lines: string[] = [];
  let line = '';
  let lineWidth = 0;
  const room = (first: boolean) => width - (first ? 0 : visibleWidth(indent));
  for (const word of s.split(/(\s+)/)) {
    if (!word) { continue; }
    const ww = visibleWidth(word);
    const isSpace = /^\s+$/.test(word.replace(ANSI, ''));
    if (lineWidth + ww > room(!lines.length) && lineWidth > 0) {
      lines.push(line.trimEnd());
      if (isSpace) { line = ''; lineWidth = 0; continue; }
      line = word;
      lineWidth = ww;
      continue;
    }
    line += word;
    lineWidth += ww;
  }
  lines.push(line.trimEnd());
  return lines.map((l, i) => (i ? indent + l : l));
}

export interface StepView {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
  ms: number;
}

/** One finished tool call: what was asked, and the first line of what came back. */
export function stepLine(step: StepView): string {
  const mark = step.ok ? green('✓') : red('✗');
  const first = step.result.split('\n')[0].slice(0, 100);
  const lines = step.result.split('\n').length;
  const more = lines > 1 ? dim(` (+${lines - 1} lines)`) : '';
  return `  ${mark} ${cyan(step.tool)} ${dim(argsLine(step.args))} ${dim(`${step.ms}ms`)}\n    ${dim(first)}${more}`;
}

/** The arguments worth reading at a glance; long values are cut, content is only counted. */
function argsLine(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const s = String(v);
      if (k === 'content' || k === 'replace' || k === 'search') { return `${k}=<${s.split('\n').length} lines>`; }
      return `${k}=${s.length > 60 ? s.slice(0, 57) + '...' : s}`;
    })
    .join(' ');
}

/**
 * A staged edit as a diff hunk. The whole of both sides is shown: a search
 * block is a few lines by construction, and the user is approving all of it.
 */
export function stagedDiff(staged: StagedChange, fileText: string): string {
  const line = fileText.slice(0, staged.at).split('\n').length;
  const minus = staged.before.split('\n').map((l) => red(`- ${l}`));
  const plus = staged.after.split('\n').map((l) => green(`+ ${l}`));
  return [bold(`${staged.path}:${line}`), ...minus, ...plus].join('\n');
}

/** What a run took. A chat reply has no steps, so it has no step count either. */
export function runSummary(o: { steps?: unknown[]; totalMs: number; promptTokens: number; replyTokens: number; hitCap?: boolean }): string {
  const cap = o.hitCap ? yellow(' · stopped at the step cap') : '';
  const steps = o.steps ? `${o.steps.length} step(s) · ` : '';
  return dim(`${steps}${(o.totalMs / 1000).toFixed(1)}s · prompt ${o.promptTokens} tok · reply ${o.replyTokens} tok`) + cap;
}
