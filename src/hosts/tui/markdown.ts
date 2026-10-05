import {
  bold, dim, italic, underline, strike, cyan, green, magenta, yellow, blue, visibleWidth, wrap,
} from './render';

/**
 * Markdown as the terminal can show it: what models answer in, rendered with
 * styles instead of markup. Deliberately forgiving: anything it does not
 * recognise comes through as the text it is.
 */
export function renderMarkdown(md: string, width: number): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const consumed = codeBlock(lines, i, width, out) || table(lines, i, width, out) || single(lines[i], width, out);
    i += consumed;
  }
  // Blank runs collapse to one, and none lead or trail.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

/** One non-block line: a heading, a rule, a list item, a quote, or a paragraph line. */
function single(line: string, width: number, out: string[]): number {
  for (const kind of LINE_KINDS) {
    const rendered = kind(line, width);
    if (rendered) { out.push(...rendered); return 1; }
  }
  out.push(...(line.trim() ? wrap(inline(line), width) : ['']));
  return 1;
}

type LineKind = (line: string, width: number) => string[] | undefined;

const heading: LineKind = (line) => {
  const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (!m) { return undefined; }
  const text = inline(m[2]);
  return ['', m[1].length === 1 ? bold(underline(text)) : m[1].length === 2 ? bold(text) : bold(dim(text))];
};

const rule: LineKind = (line, width) =>
  (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ? [dim('─'.repeat(Math.min(width, 60)))] : undefined);

/** Bullets, numbers and task boxes; wrapped lines line up under the item's text. */
const listItem: LineKind = (line, width) => {
  const m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
  if (!m) { return undefined; }
  const [, pad, marker, task, rest] = m;
  const bullet = task ? (/x/i.test(task) ? green('☑') : '☐') : /\d/.test(marker) ? marker : dim('•');
  const lead = `${' '.repeat(Math.floor(pad.length / 2) * 2)}${bullet} `;
  return wrap(lead + inline(rest), width, ' '.repeat(visibleWidth(lead)));
};

const quote: LineKind = (line, width) => {
  const m = /^\s*>\s?(.*)$/.exec(line);
  return m ? wrap(inline(m[1]), width - 2).map((l) => `${dim('│')} ${italic(l)}`) : undefined;
};

const LINE_KINDS = [heading, rule, listItem, quote];

/** A fenced block, boxed with its language and lightly highlighted. Returns the lines it took, or 0. */
function codeBlock(lines: string[], i: number, width: number, out: string[]): number {
  const open = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(lines[i]);
  if (!open) { return 0; }
  const fence = open[2];
  let end = i + 1;
  while (end < lines.length && !lines[end].trim().startsWith(fence)) { end++; }
  const body = lines.slice(i + 1, end).map((l) => l.slice(Math.min(open[1].length, l.length - l.trimStart().length)));
  const lang = open[3].toLowerCase();

  out.push(dim('╭─' + (lang ? ` ${lang} ` : '') + '─'.repeat(Math.max(0, Math.min(width, 60) - 4 - lang.length))));
  const highlight = highlighter(lang);
  for (const l of body) { out.push(`${dim('│')} ${highlight(l)}`); }
  out.push(dim('╰─'));
  return end - i + (end < lines.length ? 1 : 0);
}

/** A pipe table with a separator row under its header, aligned into columns. Returns the lines it took, or 0. */
function table(lines: string[], i: number, width: number, out: string[]): number {
  const parsed = parseTable(lines, i);
  if (!parsed) { return 0; }
  // Too wide for the terminal: leave it as the model wrote it rather than wrap mid-cell.
  out.push(...(drawTable(parsed.rows, parsed.align, width) ?? lines.slice(i, parsed.end).map((l) => inline(l))));
  return parsed.end - i;
}

interface ParsedTable { rows: string[][]; align: Array<'left' | 'right'>; end: number }

function parseTable(lines: string[], i: number): ParsedTable | undefined {
  const isRow = (l: string | undefined) => l !== undefined && /^\s*\|.*\|\s*$/.test(l);
  if (!isRow(lines[i]) || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) { return undefined; }
  let end = i + 2;
  while (isRow(lines[end])) { end++; }
  const split = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|');
  const align = split(lines[i + 1]).map((c): 'left' | 'right' => (/:\s*$/.test(c) ? 'right' : 'left'));
  const rows = [lines[i], ...lines.slice(i + 2, end)].map((l) => split(l).map((c) => inline(c.trim())));
  return { rows, align, end };
}

/** Box-drawn rows, the header bold; undefined when the table cannot fit `width`. */
function drawTable(rows: string[][], align: Array<'left' | 'right'>, width: number): string[] | undefined {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.map((r) => visibleWidth(r[c] ?? ''))));
  if (widths.reduce((a, b) => a + b + 3, 1) > width) { return undefined; }

  const cell = (s: string, c: number) => {
    const gap = ' '.repeat(widths[c] - visibleWidth(s));
    return ` ${align[c] === 'right' ? gap + s : s + gap} `;
  };
  const row = (r: string[]) => dim('│') + widths.map((_, c) => cell(r[c] ?? '', c)).join(dim('│')) + dim('│');
  const line = (l: string, m: string, r: string) => dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  return [
    line('┌', '┬', '┐'), row(rows[0].map((s) => bold(s))), line('├', '┼', '┤'),
    ...rows.slice(1).map(row),
    line('└', '┴', '┘'),
  ];
}

/**
 * Inline markup. Code spans and links are cut out first, so nothing inside
 * them (an underscore in a URL, a star in code) is read as emphasis.
 */
export function inline(text: string): string {
  return text.split(/(`+[^`]+`+|!?\[[^\]]+\]\([^)\s]+[^)]*\))/).map((part) => {
    const code = /^(`+)([^`]+)\1$/.exec(part);
    if (code) { return cyan(code[2]); }
    const link = /^!?\[([^\]]+)\]\(([^)\s]+)[^)]*\)$/.exec(part);
    if (link) { return link[1] === link[2] ? underline(link[2]) : `${underline(emphasis(link[1]))} ${dim(`(${link[2]})`)}`; }
    return emphasis(part);
  }).join('');
}

function emphasis(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, (_, s) => bold(italic(s)))
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => bold(a ?? b))
    .replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, (_, pre, s) => pre + italic(s))
    .replace(/(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, (_, pre, s) => pre + italic(s))
    .replace(/~~(.+?)~~/g, (_, s) => strike(s));
}

// ---------- code ----------

const KEYWORDS = new Set((
  'abstract as async await break case catch class const continue def default defer del delete do elif else enum ' +
  'export extends false final finally fn for from func function go if impl implements import in instanceof interface ' +
  'is lambda let loop match mod module mut namespace new nil none not null or override package pass private protected ' +
  'pub public raise readonly return select self static struct super switch this throw throws trait true try type ' +
  'typeof undefined union unsafe use val var void where while with yield True False None'
).split(' '));

const PLAIN = new Set(['', 'text', 'txt', 'plain', 'output', 'console']);
const DIFF = new Set(['diff', 'patch']);
const HASH_COMMENTS = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'rb', 'ruby', 'yaml', 'yml', 'toml', 'r', 'ini', 'conf', 'dockerfile', 'make', 'makefile']);
const DASH_COMMENTS = new Set(['sql', 'lua']);
const TOKEN = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|0x[\da-f]+)\b|\b([A-Za-z_]\w*)\b/gi;
/** Text before a comment marker with every quote closed; otherwise the marker sits inside a string. */
const QUOTES_BALANCED = /^(?:[^"'`]*(["'`])(?:(?!\1).)*\1)*[^"'`]*$/;

/** Comments dim, strings green, numbers yellow, keywords magenta, types blue; one line at a time. */
function highlighter(lang: string): (line: string) => string {
  if (PLAIN.has(lang)) { return (l) => l; }
  if (DIFF.has(lang)) { return diffLine; }
  // Only the marker: the comment runs from the first one outside a string to the end of the line.
  const comment = HASH_COMMENTS.has(lang) ? /#/g : DASH_COMMENTS.has(lang) ? /--/g : /\/\/|\/\*|^\s*\*/g;
  return (line) => {
    const at = commentStart(line, comment);
    return line.slice(0, at).replace(TOKEN, paintToken) + (at < line.length ? dim(line.slice(at)) : '');
  };
}

function diffLine(l: string): string {
  if (l.startsWith('+')) { return green(l); }
  if (l.startsWith('-')) { return magenta(l); }
  return l.startsWith('@@') ? cyan(l) : l;
}

/** Where the line's comment starts: the first marker outside a string, else the line's length. */
function commentStart(line: string, comment: RegExp): number {
  for (const m of line.matchAll(comment)) {
    if (QUOTES_BALANCED.test(line.slice(0, m.index))) { return m.index!; }
  }
  return line.length;
}

function paintToken(m: string, str?: string, num?: string, word?: string): string {
  if (str) { return green(str); }
  if (num) { return yellow(num); }
  if (!word) { return m; }
  if (KEYWORDS.has(word)) { return magenta(word); }
  return /^[A-Z][a-z]\w*$/.test(word) ? blue(word) : m;
}
