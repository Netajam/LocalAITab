interface Entry {
  prefix: string;
  suffix: string;
  completion: string;
}

/**
 * Small LRU with one extra trick: if the user keeps typing the characters the
 * model already suggested, we serve the remainder of that suggestion instead of
 * issuing a fresh request. This is what makes accepting a completion word by
 * word feel instant.
 */
export class CompletionCache {
  private entries: Entry[] = [];

  constructor(private readonly max = 40) {}

  get(prefix: string, suffix: string): string | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const hit = serve(this.entries[i], prefix, suffix);
      if (hit !== undefined) {
        this.touch(i);
        return hit;
      }
    }
    return undefined;
  }

  set(prefix: string, suffix: string, completion: string): void {
    this.entries.push({ prefix, suffix, completion });
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
    }
  }

  clear(): void {
    this.entries = [];
  }

  private touch(i: number): void {
    const [e] = this.entries.splice(i, 1);
    this.entries.push(e);
  }
  private remove(i: number): void {
    this.entries.splice(i, 1);
  }
}

/**
 * What an entry offers at this cursor: its completion on an exact match, or the
 * rest of it when the user typed further into what was suggested (as long as
 * something other than whitespace is left).
 */
function serve(e: Entry, prefix: string, suffix: string): string | undefined {
  if (e.suffix !== suffix || !prefix.startsWith(e.prefix)) { return undefined; }
  const typed = prefix.slice(e.prefix.length);
  if (!typed) { return e.completion; }
  const rest = e.completion.startsWith(typed) ? e.completion.slice(typed.length) : '';
  return rest.trim() ? rest : undefined;
}
