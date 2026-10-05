import * as readline from 'readline/promises';

/**
 * The terminal when input is not one: piped or scripted. Plain lines in and
 * out, no pane, no popups; questions take a typed answer. It has the shape of
 * terminal.ts's Terminal, which is what createTerminal checks it against.
 */
export class LineTerminal {
  private readonly rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  // Lines are buffered as they arrive; question() would drop those that come
  // before it is called, which with piped input is all of them.
  private readonly lines = this.rl[Symbol.asyncIterator]();
  private interrupt?: () => void;
  private mode = 'agent';

  constructor() {
    this.rl.on('SIGINT', () => this.interrupt?.());
  }

  get width(): number { return process.stdout.columns || 100; }

  print(text: string): void { process.stdout.write(text + '\n'); }
  status(): void { /* nothing to redraw */ }
  preview(): void { /* the answer prints whole when it is done */ }
  setInfo(info: { mode: string }): void { this.mode = info.mode; }
  setCommands(): void { /* no completion */ }
  onInterrupt(handler: () => void): void { this.interrupt = handler; }
  onCycleMode(): void { /* no shortcut keys */ }

  async read(): Promise<string | undefined> {
    // No footer here, so the prompt carries the mode, as a tag rather than a speaker.
    return this.ask(`[${this.mode}] ❯ `);
  }

  async choose(question: string, choices: Array<{ key: string; label: string }>, signal?: AbortSignal): Promise<string | undefined> {
    const keys = choices.map((c) => `[${c.key}] ${c.label}`).join(' / ');
    const answer = (await this.ask(`${question}  ${keys}: `, signal))?.trim().toLowerCase();
    return choices.find((c) => c.key === answer)?.key;
  }

  close(): void { this.rl.close(); }

  /** The next line, or undefined at the end of input or when `signal` aborts first. */
  private async ask(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    process.stdout.write(prompt);
    if (signal?.aborted) { return undefined; }
    const aborted = new Promise<undefined>((resolve) => signal?.addEventListener('abort', () => resolve(undefined), { once: true }));
    const next = this.lines.next().then((r) => (r.done ? undefined : r.value));
    const line = await Promise.race([next, aborted]);
    process.stdout.write('\n');
    return line;
  }
}
