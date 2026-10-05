import * as vscode from 'vscode';
import { buildPrompt, postProcess, shouldBeMultiline, NeighborFile, STOP_TOKENS } from '../../../core/llm/fim';
import { generate, GenerateRequest, GenerateResult, OllamaError } from '../../../core/llm/ollama';
import { CompletionCache } from './cache';

export interface Stats {
  requests: number;
  served: number;
  cacheHits: number;
  aborted: number;
  errors: number;
  lastMs: number;
  lastTokens: number;
}

/** One completion attempt: where it is, what surrounds it, and how it was asked for. */
interface CompletionRequest {
  document: vscode.TextDocument;
  cfg: vscode.WorkspaceConfiguration;
  manual: boolean;
  token: vscode.CancellationToken;
  prefix: string;
  suffix: string;
  multiline: boolean;
  /** Pairs with prefix in the cache; the mode matters as much as the suffix. */
  cacheKey: string;
}

export class LocalCompletionProvider implements vscode.InlineCompletionItemProvider {
  readonly stats: Stats = {
    requests: 0, served: 0, cacheHits: 0, aborted: 0, errors: 0, lastMs: 0, lastTokens: 0,
  };

  private cache = new CompletionCache();
  private inFlight?: AbortController;
  private lastErrorShown = 0;
  /** Why the most recent explicit trigger produced nothing, for the diagnose command. */
  lastSkip?: string;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly isEnabled: () => boolean,
    private readonly onActivity: () => void,
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const req = this.prepare(document, position, context, token);
    if (!req) { return; }

    const cached = this.cache.get(req.prefix, req.cacheKey);
    if (cached !== undefined) {
      this.stats.cacheHits++;
      this.stats.served++;
      return [this.toItem(cached, position)];
    }

    if (!req.manual && !(await debounce(req.cfg, token))) { return; }

    const text = await this.complete(req);
    if (text === undefined) { return undefined; }

    this.lastSkip = undefined;
    this.cache.set(req.prefix, req.cacheKey, text);
    this.stats.served++;
    return [this.toItem(text, position)];
  }

  /**
   * Decides whether this trigger deserves a completion at all and, if so,
   * gathers what the request needs. Undefined means decline (reported via
   * skip when the user asked explicitly).
   */
  private prepare(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): CompletionRequest | undefined {
    const cfg = vscode.workspace.getConfiguration('localAITab');
    const manual = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;

    const refusal = this.refusal(document, cfg);
    if (refusal) { return this.skip(manual, refusal); }

    // In manual mode (the default) VS Code still polls us as the user types.
    // Declining anything that is not an explicit Invoke is what keeps
    // suggestions from appearing uninvited.
    if (!manual && cfg.get<string>('trigger', 'manual') !== 'automatic') { return; }

    const { prefix, suffix, lineSuffix } = sliceContext(document, position, cfg);

    // Typing inside a word: the model has no clean boundary to complete at.
    if (!manual && /^\w/.test(lineSuffix)) { return; }

    if (!prefix.trim() && !suffix.trim()) { return this.skip(manual, 'the document is empty'); }

    const multiline = shouldBeMultiline(lineSuffix, cfg.get<string>('multiline', 'auto'));
    const cacheKey = `${multiline ? 'M' : 'S'} ${suffix}`;
    return { document, cfg, manual, token, prefix, suffix, multiline, cacheKey };
  }

  /**
   * Every bail-out goes through here and is logged when the request was
   * explicitly asked for. A manual trigger that silently produces nothing is
   * the single most confusing thing this extension can do, so it always
   * leaves a trace.
   */
  private skip(manual: boolean, reason: string): undefined {
    if (manual) {
      this.lastSkip = reason;
      this.output.appendLine(`[skip] ${reason}`);
    }
    return undefined;
  }

  /** Why this document gets no completions at all, if it doesn't. */
  private refusal(document: vscode.TextDocument, cfg: vscode.WorkspaceConfiguration): string | undefined {
    if (!this.isEnabled()) {
      return 'extension is toggled off (click the status bar item)';
    }
    const disabled = cfg.get<string[]>('disabledLanguages', []);
    if (disabled.includes(document.languageId)) {
      return `language "${document.languageId}" is in localAITab.disabledLanguages`;
    }
    return undefined;
  }

  /**
   * Runs one model request, superseding any still in flight. Resolves to the
   * cleaned-up completion, or undefined (already reported) when there is none.
   */
  private async complete(req: CompletionRequest): Promise<string | undefined> {
    this.inFlight?.abort();
    const ac = new AbortController();
    this.inFlight = ac;

    const timeoutMs = req.cfg.get<number>('timeoutMs', 3000);
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const sub = req.token.onCancellationRequested(() => ac.abort());

    try {
      this.stats.requests++;
      this.onActivity();
      const result = await generate(generateRequest(req, ac.signal));
      return this.accept(req, result);
    } catch (err) {
      return this.fail(req, err as Error, ac.signal.aborted, timeoutMs);
    } finally {
      clearTimeout(timer);
      sub.dispose();
      if (this.inFlight === ac) { this.inFlight = undefined; }
    }
  }

  private accept(req: CompletionRequest, result: GenerateResult): string | undefined {
    this.stats.lastMs = result.totalMs;
    this.stats.lastTokens = result.evalCount;

    const text = postProcess(result.text, { suffix: req.suffix, multiline: req.multiline });
    this.output.appendLine(
      `[${new Date().toISOString()}] ${result.totalMs}ms ${result.evalCount}tok ` +
      `${req.multiline ? 'multi' : 'single'} -> ${JSON.stringify(text.slice(0, 80))}`,
    );

    if (!text) {
      return this.skip(
        req.manual,
        `the model returned nothing usable (raw: ${JSON.stringify(result.text.slice(0, 120))})`,
      );
    }
    return text;
  }

  private fail(req: CompletionRequest, err: Error, aborted: boolean, timeoutMs: number): undefined {
    const cancelled = req.token.isCancellationRequested;
    if (aborted || cancelled) {
      this.stats.aborted++;
      // A timeout and a superseded keystroke both land here; only the former
      // is worth telling the user about, and only when they asked explicitly.
      return this.skip(
        req.manual,
        cancelled
          ? 'VS Code cancelled the request (superseded or the editor lost focus)'
          : `timed out after ${timeoutMs}ms (raise localAITab.timeoutMs)`,
      );
    }
    this.stats.errors++;
    this.reportError(err);
    return this.skip(req.manual, `request failed: ${err.message}`);
  }

  private toItem(text: string, position: vscode.Position): vscode.InlineCompletionItem {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
  }

  private reportError(err: Error): void {
    this.output.appendLine(`[error] ${err.message}`);
    // Don't spam the user when Ollama is simply down.
    const now = Date.now();
    if (err instanceof OllamaError && now - this.lastErrorShown > 60_000) {
      this.lastErrorShown = now;
      vscode.window.showWarningMessage(`LocalAITab: ${err.message}`);
    }
  }
}

/** The text either side of the cursor, clipped to the configured budgets. */
function sliceContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  cfg: vscode.WorkspaceConfiguration,
): { prefix: string; suffix: string; lineSuffix: string } {
  const lineSuffix = document.lineAt(position.line).text.slice(position.character);

  const offset = document.offsetAt(position);
  const full = document.getText();
  const prefixChars = cfg.get<number>('prefixChars', 3000);
  const suffixChars = cfg.get<number>('suffixChars', 1500);

  return {
    prefix: full.slice(Math.max(0, offset - prefixChars), offset),
    suffix: full.slice(offset, offset + suffixChars),
    lineSuffix,
  };
}

/**
 * Debounce: VS Code calls us on every keystroke pause, so wait out the typing
 * burst. False when a newer request has already superseded this one.
 */
async function debounce(cfg: vscode.WorkspaceConfiguration, token: vscode.CancellationToken): Promise<boolean> {
  const debounceMs = cfg.get<number>('debounceMs', 300);
  await new Promise((r) => setTimeout(r, debounceMs));
  return !token.isCancellationRequested;
}

function generateRequest(req: CompletionRequest, signal: AbortSignal): GenerateRequest {
  const { document, cfg } = req;
  const prompt = buildPrompt({
    prefix: req.prefix,
    suffix: req.suffix,
    filePath: vscode.workspace.asRelativePath(document.uri),
    repoName: vscode.workspace.workspaceFolders?.[0]?.name,
    neighbors: cfg.get<boolean>('neighborFiles', true)
      ? collectNeighbors(document, cfg.get<number>('neighborBudget', 2000))
      : [],
  });

  return {
    endpoint: cfg.get<string>('endpoint', 'http://localhost:11434'),
    model: cfg.get<string>('model', 'qwen2.5-coder:3b-base'),
    prompt,
    temperature: cfg.get<number>('temperature', 0.1),
    maxTokens: cfg.get<number>('maxTokens', 256),
    keepAlive: cfg.get<string>('keepAlive', '30m'),
    stop: req.multiline ? STOP_TOKENS : [...STOP_TOKENS, '\n'],
    signal,
  };
}

/**
 * Other visible editors, newest first, as repo-level FIM context. Only whole
 * small files are worth sending: a truncated middle of a large file tends to
 * confuse the model more than it helps.
 */
function collectNeighbors(current: vscode.TextDocument, budget: number): NeighborFile[] {
  const out: NeighborFile[] = [];
  let remaining = budget;

  for (const editor of vscode.window.visibleTextEditors) {
    const doc = editor.document;
    if (doc.uri.toString() === current.uri.toString()) { continue; }
    if (doc.uri.scheme !== 'file') { continue; }
    if (doc.languageId !== current.languageId) { continue; }

    const text = doc.getText();
    if (!text.trim() || text.length > remaining) { continue; }

    out.push({ path: vscode.workspace.asRelativePath(doc.uri), text });
    remaining -= text.length;
    if (remaining <= 0) { break; }
  }
  return out;
}
