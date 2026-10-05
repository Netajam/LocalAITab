/**
 * The SKILL.md format, as other agent harnesses use it.
 *
 * A skill is a folder holding a SKILL.md: YAML frontmatter naming and
 * describing it, then Markdown instructions. Only the name and description are
 * shown up front; the body is read when the skill is used. That split matters
 * more here than in a hosted harness, since a local model's window is small.
 *
 * Kept free of the vscode API so it can be tested under node.
 */

export interface Skill {
  name: string;
  description: string;
  /** The instructions: SKILL.md after its frontmatter. */
  body: string;
  /** Shown after the name in the slash suggestion list. */
  argumentHint: string;
  /** False hides it from the slash commands (`user-invocable: false`). */
  userInvocable: boolean;
  /** False keeps it out of the agent's catalog (`disable-model-invocation: true`). */
  modelInvocable: boolean;
  /** Absolute path of the skill's folder. */
  dir: string;
  /** Other files in the folder, relative to it: references, templates, scripts. */
  files: string[];
}

export type ParsedSkill = Omit<Skill, 'dir' | 'files'>;

/** Lowercase letters, digits and hyphens, as the format requires. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Parses one SKILL.md. The folder name stands in for a missing `name`, and the
 * first line of the body for a missing `description`, as Claude Code does.
 */
export function parseSkill(raw: string, dirName: string): ParsedSkill | { error: string } {
  const { meta, body } = splitFrontmatter(raw.replace(/^﻿/, '').replace(/\r\n/g, '\n'));

  const name = (meta.name || dirName).trim();
  if (!SKILL_NAME.test(name)) {
    return { error: `"${name}" is not a valid skill name (lowercase letters, digits and hyphens).` };
  }

  const description = (meta.description || firstLine(body)).trim();
  if (!description) {
    return { error: `${name} has no description, so there is nothing to decide when to use it by.` };
  }

  return {
    name,
    description,
    body: body.trim(),
    argumentHint: (meta['argument-hint'] ?? '').trim(),
    userInvocable: !isFalse(meta['user-invocable']),
    modelInvocable: !isTrue(meta['disable-model-invocation']),
  };
}

/**
 * One top-level `key: value` line (group 1, 2) and the indented or blank lines
 * that follow it (group 3), which belong to that key. Anything else -- comments,
 * list items at column 0 -- is never matched and so skipped.
 */
const ENTRY = /(?<![^\n])([A-Za-z][\w-]*):[ \t]*(.*)(?![^\n])((?:\n(?:[ \t]+\S[^\n]*|[^\S\n]*(?![^\n])))*)/g;

/**
 * Minimal YAML frontmatter: top-level `key: value` pairs, quoted strings, and
 * `|` / `>` block scalars, which descriptions often use. Nested maps such as
 * `metadata:` are skipped rather than misread. A full YAML parser would be a
 * dependency for the sake of a handful of scalar fields.
 */
export function splitFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) { return { meta: {}, body: text }; }

  const meta: Record<string, string> = {};
  for (const [, key, raw, tail] of m[1].matchAll(ENTRY)) {
    const value = raw.replace(/[ \t]+#.*$/, '').trim();
    // Drop trailing blank lines, then the newline that opens the tail.
    const continuation = tail.replace(/(?:\n[^\S\n]*)*$/, '').split('\n').slice(1);

    if (/^[|>][+-]?$/.test(value)) {
      meta[key] = blockScalar(value, continuation);
    } else if (value) {
      meta[key] = unquote([value, ...continuation.map((l) => l.trim())].join(' ').trim());
    }
    // An empty value opens a nested map or list; nothing here reads those.
  }

  return { meta, body: text.slice(m[0].length) };
}

/** `|` keeps line breaks, `>` folds them; both drop the common indentation. */
function blockScalar(indicator: string, lines: string[]): string {
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  const block = lines.map((l) => l.slice(indent));
  return indicator.startsWith('|') ? block.join('\n') : fold(block);
}

/** Folded scalar: a line break becomes a space, each blank line a newline. */
function fold(lines: string[]): string {
  return lines.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/\n(\n+)/g, '$1');
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

const isTrue = (v: string | undefined) => /^(true|yes|on)$/i.test((v ?? '').trim());
const isFalse = (v: string | undefined) => /^(false|no|off)$/i.test((v ?? '').trim());

function firstLine(body: string): string {
  return body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
}

/**
 * The message a skill invocation sends. `$ARGUMENTS` and `$ARGUMENTS[n]` in
 * the body are replaced; if the body uses neither, the arguments are appended
 * so they are not silently lost.
 *
 * `note` goes after the skill. Operator mode overrides skills written for a
 * harness that cannot touch files with it: the model follows the skill over
 * its tool list, so the override has to sit next to the skill.
 */
export function expandSkill(
  skill: Pick<Skill, 'name' | 'body' | 'files'>, args: string, withFiles: boolean, note = '',
): string {
  const words = args.trim() ? args.trim().split(/\s+/) : [];
  const uses = /\$ARGUMENTS\b/.test(skill.body);

  const body = skill.body
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_, n) => words[Number(n)] ?? '')
    .replace(/\$ARGUMENTS\b/g, args.trim());

  const parts = [`<skill name="${skill.name}">`, body, '</skill>'];
  if (withFiles && skill.files.length) {
    parts.push('', `Files bundled with this skill, readable with load_skill: ${skill.files.join(', ')}`);
  }
  if (!uses && args.trim()) {
    parts.push('', `ARGUMENTS: ${args.trim()}`);
  }
  if (note) {
    parts.push('', note);
  }
  return parts.join('\n');
}

/** The catalog the agent sees: one line per skill, never the bodies. */
export function renderCatalog(skills: Array<Pick<Skill, 'name' | 'description'>>): string {
  if (!skills.length) { return ''; }
  return [
    'Skills are instructions for particular tasks. When a request matches one, call',
    'load_skill with its name first and follow what it says.',
    '',
    ...skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ')}`),
  ].join('\n');
}
