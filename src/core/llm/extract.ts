/**
 * Pulls runnable code back out of an instruct model's reply.
 *
 * Even with a blunt "return only code" system prompt, models wrap output in
 * markdown fences, prepend a sentence, or emit a reasoning block first. This
 * module is deliberately free of any vscode import so it can be unit-tested.
 */

/** Removes <think>...</think> reasoning blocks, including an unclosed leading one. */
export function stripThinking(raw: string): string {
  let out = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // A reply truncated mid-thought, or one whose opening tag the server ate,
  // can leave a dangling close tag with the reasoning ahead of it.
  if (!/<think>/i.test(out) && /<\/think>/i.test(out)) {
    out = out.replace(/^[\s\S]*?<\/think>/i, '');
  }
  return out.trim();
}

/**
 * Returns the contents of the first fenced code block, or the whole text with
 * stray fences trimmed when the reply was not fenced at all.
 */
export function stripFences(raw: string): string {
  const fenced = raw.match(/```[a-zA-Z0-9_+#-]*[ \t]*\r?\n([\s\S]*?)```/);
  if (fenced) { return fenced[1]; }

  return raw
    .replace(/^```[a-zA-Z0-9_+#-]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?```\s*$/, '');
}

export function cleanCode(raw: string): string {
  let out = stripThinking(raw);
  out = stripFences(out);
  // Leading blank lines are formatting noise; trailing whitespace would dirty the diff.
  return out.replace(/^(\r?\n)+/, '').replace(/\s+$/, '');
}

const leadingWhitespace = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0];

function minIndent(lines: string[]): number | null {
  const filled = lines.filter((l) => l.trim());
  if (!filled.length) { return null; }
  return filled.reduce((m, l) => Math.min(m, leadingWhitespace(l).length), Infinity);
}

/**
 * Restores the original block indentation on a rewritten snippet.
 *
 * The result is spliced back into the middle of a file, so indentation has to
 * survive the round trip. Models reliably get this wrong in two ways: they drop
 * the indent on the first line only (having seen it as the start of the text),
 * or they dedent the whole block to column zero. Asking nicely in the system
 * prompt is not dependable, so both cases are repaired here instead.
 */
export function matchIndentation(original: string, result: string): string {
  const origLines = original.split('\n');
  const resLines = result.split('\n');

  const origBase = leadingWhitespace(origLines[0]);
  if (!origBase) { return result; }

  // The body still lines up, so only the first line lost its indentation.
  // (When the first line was already right, this rebuilds it unchanged.)
  const origBody = minIndent(origLines.slice(1));
  if (origBody !== null && origBody === minIndent(resLines.slice(1))) {
    resLines[0] = origBase + resLines[0].replace(/^[ \t]*/, '');
    return resLines.join('\n');
  }

  // Otherwise the whole block was shifted; push it back by the difference,
  // reusing the original's whitespace characters so tabs stay tabs.
  const delta = origBase.length - leadingWhitespace(resLines[0]).length;
  if (delta <= 0) { return result; }
  const pad = origBase.slice(0, delta);

  return resLines.map((l) => (l.trim() ? pad + l : l)).join('\n');
}
