/**
 * Instructions and prompt text for the refactor commands. Free of any vscode
 * import, like extract.ts, so the prompts can be unit-tested.
 */

export interface RefactorPreset {
  label: string;
  detail: string;
  instruction: string;
}

export const PRESETS: RefactorPreset[] = [
  {
    label: '$(sparkle) Simplify',
    detail: 'Reduce nesting and remove redundancy, keeping behaviour identical',
    instruction: 'Simplify this code. Reduce nesting and remove redundancy. Behaviour must stay identical.',
  },
  {
    label: '$(symbol-type-parameter) Add types',
    detail: 'Add or tighten type annotations',
    instruction: 'Add or tighten type annotations throughout. Do not change runtime behaviour.',
  },
  {
    label: '$(comment) Document',
    detail: 'Add a docstring or doc comment',
    instruction: 'Add a concise docstring or doc comment in the conventional style for this language. Leave the code itself unchanged.',
  },
  {
    label: '$(symbol-method) Extract functions',
    detail: 'Split into smaller well-named units',
    instruction: 'Split this into smaller, well-named functions. Keep the public entry point and its signature unchanged.',
  },
  {
    label: '$(shield) Handle errors',
    detail: 'Add error handling for the realistic failure modes',
    instruction: 'Add error handling for the realistic failure modes in this code. Do not invent new dependencies.',
  },
  {
    label: '$(beaker) Make idiomatic',
    detail: 'Rewrite in the idiomatic style of this language',
    instruction: 'Rewrite this in the idiomatic style of the language, using its standard library where it helps. Behaviour must stay identical.',
  },
  {
    label: '$(edit) Custom instruction...',
    detail: 'Describe the refactor yourself',
    instruction: '',
  },
];

/** The catch-all instruction behind "Make This Better". */
export const IMPROVE_INSTRUCTION = [
  'Improve this code without changing what it does.',
  'Fix real bugs and unhandled edge cases if you find any.',
  'Prefer clearer names, less nesting, and the idioms of this language.',
  'Keep the public API -- names, signatures, exports -- exactly as it is,',
  'so callers elsewhere in the project keep working.',
  'Do not add dependencies, and do not add comments that merely restate the code.',
  'If the code is already good, return it unchanged.',
].join(' ');

/** Sent after a rewrite broke the build, with the compiler's own errors attached. */
export function buildRepairPrompt(opts: {
  languageId: string;
  code: string;
  errors: string;
}): string {
  return [
    `Language: ${opts.languageId}`,
    '',
    'Your previous rewrite introduced these errors:',
    opts.errors,
    '',
    'Fix them. Change as little as possible, and keep the improvements that did work.',
    '',
    'Code to fix:',
    opts.code,
  ].join('\n');
}

export type ContextScope = 'none' | 'surrounding' | 'file' | 'openTabs';

export const SCOPE_LABELS: Record<ContextScope, string> = {
  none: 'Selection only -- fastest, no surrounding code',
  surrounding: 'Surrounding lines -- a window either side of the selection',
  file: 'Whole file -- the model sees every definition in this file',
  openTabs: 'Whole file + open tabs -- widest, slowest',
};

export const SYSTEM_PROMPT = [
  'You are a refactoring engine embedded in an editor.',
  'You rewrite the code snippet the user provides, according to their instruction.',
  '',
  'Rules:',
  '- Reply with the rewritten code and nothing else.',
  '- No explanation, no commentary, no markdown code fences.',
  '- Preserve the leading indentation of the original snippet exactly, because',
  '  the result is spliced back into the middle of a larger file.',
  '- Do not add imports that were not already present unless the instruction',
  '  explicitly calls for them.',
  '- If the instruction cannot sensibly be applied, return the original snippet unchanged.',
].join('\n');

export interface ExtraFile {
  path: string;
  text: string;
}

export function buildUserPrompt(opts: {
  languageId: string;
  filePath: string;
  instruction: string;
  code: string;
  context?: string;
  extraFiles?: ExtraFile[];
}): string {
  const parts = [`Language: ${opts.languageId}`, `File: ${opts.filePath}`];

  for (const f of opts.extraFiles ?? []) {
    parts.push('', `Related file ${f.path}, for reference only (do not return it):`, f.text);
  }
  if (opts.context) {
    parts.push('', 'Surrounding code, for reference only (do not return it):', opts.context);
  }
  parts.push('', `Instruction: ${opts.instruction}`, '', 'Snippet to rewrite:', opts.code);

  return parts.join('\n');
}
