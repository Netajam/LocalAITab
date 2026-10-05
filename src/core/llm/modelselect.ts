/**
 * Choosing a stand-in instruct model when the configured one is not installed.
 *
 * Kept free of any vscode import so the selection rules can be unit tested
 * against the compiled output directly.
 */

/** A `-base` tag is a FIM/completion model; it cannot follow instructions. */
export function isBaseTag(tag: string): boolean {
  return /-base\b/.test(tag);
}

/**
 * Approximate parameter count in billions parsed from a tag:
 * "qwen2.5-coder:7b-instruct" -> 7, "qwen3.6:35b-a3b-coding" -> 35 (the total,
 * not the MoE active count). Returns 0 when the tag carries no size.
 */
export function paramSize(tag: string): number {
  const m = tag.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Picks an instruct substitute from what is installed: the first entry of
 * `preferred` that is present, otherwise the largest installed non-base model,
 * biased towards coder tags. Returns undefined when nothing usable is installed.
 */
export function chooseFallback(installed: string[], preferred: string[]): string | undefined {
  for (const p of preferred) {
    if (p && installed.includes(p)) { return p; }
  }

  const candidates = installed.filter((m) => !isBaseTag(m));
  if (!candidates.length) { return undefined; }

  const isCoder = (t: string) => (/cod(er|ing)/i.test(t) ? 1 : 0);
  candidates.sort((a, b) => {
    if (isCoder(a) !== isCoder(b)) { return isCoder(b) - isCoder(a); }
    return paramSize(b) - paramSize(a);
  });
  return candidates[0];
}

/** What a model can be used for: FIM completion, following instructions, or neither. */
export type ModelKind = 'base' | 'instruct' | 'embedding';

/**
 * Classifies an installed model from its tag and the capabilities Ollama
 * reports for it. The tag decides when it says `-base`; otherwise a model that
 * can fill in the middle but cannot call tools is taken for a base model
 * (starcoder2, codellama:*-code), since instruct coders that support FIM
 * also advertise tools. With no capabilities to go on, the tag alone decides.
 */
export function modelKind(tag: string, capabilities: string[]): ModelKind {
  if (capabilities.includes('embedding') && !capabilities.includes('completion')) { return 'embedding'; }
  if (isBaseTag(tag)) { return 'base'; }
  if (capabilities.includes('insert') && !capabilities.includes('tools')) { return 'base'; }
  return 'instruct';
}

/** Inline completion wants a base model; everything else wants an instruct one. */
export function suitsRole(role: 'completion' | 'instruct', kind: ModelKind): boolean {
  return role === 'completion' ? kind === 'base' : kind === 'instruct';
}

/** Splits installed models into those that suit a role and the rest, keeping their order. */
export function partitionForRole<M extends { kind: ModelKind }>(
  role: 'completion' | 'instruct',
  models: M[],
): { suited: M[]; others: M[] } {
  const suited: M[] = [];
  const others: M[] = [];
  for (const m of models) { (suitsRole(role, m.kind) ? suited : others).push(m); }
  return { suited, others };
}
