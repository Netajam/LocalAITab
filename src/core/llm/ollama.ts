export interface GenerateRequest {
  endpoint: string;
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
  keepAlive: string;
  /** Stop sequences; FIM callers pass the model's control tokens here. */
  stop?: string[];
  signal: AbortSignal;
}

export interface GenerateResult {
  text: string;
  evalCount: number;
  /** Tokens in the prompt, as counted by the model's own tokenizer. */
  promptEvalCount?: number;
  /** Milliseconds of generation time as reported by Ollama. */
  evalMs: number;
  totalMs: number;
}

export class OllamaError extends Error {}

/**
 * POSTs a JSON body to an Ollama endpoint. A network failure becomes an
 * OllamaError unless the caller aborted, in which case the abort propagates
 * untouched; a non-2xx status becomes an OllamaError carrying the body.
 */
async function postJson(
  endpoint: string,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${endpoint.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) { throw err; }
    throw new OllamaError(`cannot reach Ollama at ${endpoint}: ${(err as Error).message}`);
  }

  if (!res.ok) {
    throw new OllamaError(`Ollama returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return res;
}

export async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const started = Date.now();

  const body = {
    model: req.model,
    prompt: req.prompt,
    // raw:true skips Ollama's chat template -- the FIM prompt must reach the
    // model exactly as assembled, with no system/user wrapper around it.
    raw: true,
    stream: false,
    keep_alive: req.keepAlive,
    options: {
      temperature: req.temperature,
      num_predict: req.maxTokens,
      stop: req.stop ?? [],
    },
  };

  const res = await postJson(req.endpoint, '/api/generate', body, req.signal);

  const json = (await res.json()) as {
    response?: string;
    eval_count?: number;
    eval_duration?: number;
  };

  return {
    text: json.response ?? '',
    evalCount: json.eval_count ?? 0,
    evalMs: Math.round((json.eval_duration ?? 0) / 1e6),
    totalMs: Date.now() - started,
  };
}

export interface ChatRequest {
  endpoint: string;
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  keepAlive: string;
  signal: AbortSignal;
  /**
   * Only send this to a model whose capabilities include "thinking" -- Ollama
   * rejects the field outright on models that do not support it.
   */
  think?: boolean;
}

/**
 * Instruction-following counterpart to `generate`. This one deliberately does
 * NOT set raw, because an instruct model needs its chat template applied.
 */
export async function chat(req: ChatRequest): Promise<GenerateResult> {
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: req.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    stream: false,
    keep_alive: req.keepAlive,
    options: {
      temperature: req.temperature,
      num_predict: req.maxTokens,
    },
  };
  if (req.think !== undefined) { body.think = req.think; }

  const res = await postJson(req.endpoint, '/api/chat', body, req.signal);

  const json = (await res.json()) as {
    message?: { content?: string };
    eval_count?: number;
    eval_duration?: number;
  };

  return {
    text: json.message?.content ?? '',
    evalCount: json.eval_count ?? 0,
    evalMs: Math.round((json.eval_duration ?? 0) / 1e6),
    totalMs: Date.now() - started,
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamRequest {
  endpoint: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  keepAlive: string;
  signal: AbortSignal;
  think?: boolean;
  onToken: (delta: string) => void;
  /** Reasoning deltas, streamed separately from the answer by thinking models. */
  onThinking?: (delta: string) => void;
}

/**
 * Streaming multi-turn chat. Ollama replies with newline-delimited JSON, one
 * object per token batch, so the body is read incrementally and split on
 * newlines -- a chunk can end mid-object, hence the carry buffer.
 */
export async function chatStream(req: StreamRequest): Promise<GenerateResult> {
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    keep_alive: req.keepAlive,
    options: { temperature: req.temperature, num_predict: req.maxTokens },
  };
  if (req.think !== undefined) { body.think = req.think; }

  const res = await postJson(req.endpoint, '/api/chat', body, req.signal);
  if (!res.body) { throw new OllamaError('Ollama returned an empty stream'); }

  let full = '';
  let final: StreamChunk = {};
  for await (const line of ndjsonLines(res.body)) {
    const obj = parseChunk(line);
    if (!obj) { continue; }
    if (obj.error) { throw new OllamaError(obj.error); }

    full += emitDeltas(obj, req);
    if (obj.done) { final = obj; }
  }

  return {
    text: full,
    evalCount: final.eval_count ?? 0,
    promptEvalCount: final.prompt_eval_count ?? 0,
    evalMs: Math.round((final.eval_duration ?? 0) / 1e6),
    totalMs: Date.now() - started,
  };
}

interface StreamChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  error?: string;
}

/**
 * Complete lines of a streamed body. A chunk can end mid-line, so the tail is
 * carried into the next read; whatever is left when the stream ends is dropped.
 */
async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) { return; }

    carry += decoder.decode(value, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    yield* lines;
  }
}

/** One NDJSON line as a stream chunk, or undefined for a blank or partial line. */
function parseChunk(line: string): StreamChunk | undefined {
  if (!line.trim()) { return undefined; }
  try {
    return JSON.parse(line) as StreamChunk;
  } catch {
    return undefined; // a partial object; the carry buffer will pick it up
  }
}

/** Forwards a chunk's reasoning and answer deltas; returns the answer delta. */
function emitDeltas(obj: StreamChunk, req: StreamRequest): string {
  const thought = obj.message?.thinking ?? '';
  if (thought) { req.onThinking?.(thought); }

  const delta = obj.message?.content ?? '';
  if (delta) { req.onToken(delta); }
  return delta;
}

export interface ToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ToolChatRequest {
  endpoint: string;
  model: string;
  messages: unknown[];
  tools: unknown;
  temperature: number;
  maxTokens: number;
  keepAlive: string;
  signal: AbortSignal;
  think?: boolean;
}

export interface ToolChatResult {
  content: string;
  toolCalls: ToolCall[];
  /** The raw assistant message, which must be echoed back into the transcript. */
  raw: unknown;
  promptTokens: number;
  replyTokens: number;
  totalMs: number;
}

/**
 * Non-streaming chat with tools. Streaming is deliberately not used here: a
 * tool call is only actionable once complete, so there is nothing to show
 * incrementally, and assembling partial call arguments adds failure modes.
 */
export async function chatWithTools(req: ToolChatRequest): Promise<ToolChatResult> {
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    tools: req.tools,
    stream: false,
    keep_alive: req.keepAlive,
    options: { temperature: req.temperature, num_predict: req.maxTokens },
  };
  if (req.think !== undefined) { body.think = req.think; }

  const res = await postJson(req.endpoint, '/api/chat', body, req.signal);

  const json = (await res.json()) as {
    message?: { content?: string; tool_calls?: ToolCall[] };
    prompt_eval_count?: number;
    eval_count?: number;
    error?: string;
  };
  if (json.error) { throw new OllamaError(json.error); }

  return {
    content: json.message?.content ?? '',
    toolCalls: json.message?.tool_calls ?? [],
    raw: json.message ?? { role: 'assistant', content: '' },
    promptTokens: json.prompt_eval_count ?? 0,
    replyTokens: json.eval_count ?? 0,
    totalMs: Date.now() - started,
  };
}

export interface ContextWindow {
  tokens: number;
  /** True when this is the window Ollama actually loaded, not the model's ceiling. */
  running: boolean;
}

/**
 * The context window in force for a model.
 *
 * /api/ps reports what Ollama actually allocated when it loaded the model,
 * which is the number that governs truncation. It is routinely far below the
 * model's advertised maximum -- 65536 against a 262144 ceiling here -- so the
 * maximum from /api/show is only a fallback for a model that is not resident.
 */
export async function getContextWindow(endpoint: string, model: string): Promise<ContextWindow> {
  const base = endpoint.replace(/\/$/, '');

  const loaded = await probe(`${base}/api/ps`, undefined,
    (json: { models?: Array<{ name?: string; model?: string; context_length?: number }> }) =>
      json.models?.find((m) => m.name === model || m.model === model)?.context_length);
  if (loaded) { return { tokens: loaded, running: true }; }

  const ceiling = await probe(`${base}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  }, (json: { model_info?: Record<string, unknown> }) =>
    Object.entries(json.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))?.[1]);
  return { tokens: typeof ceiling === 'number' ? ceiling : 0, running: false };
}

/** Fetches `url` and picks a value from the JSON reply; any failure on the way is undefined. */
async function probe<J, T>(url: string, init: RequestInit | undefined, pick: (json: J) => T): Promise<T | undefined> {
  try {
    const res = await fetch(url, init);
    return res.ok ? pick((await res.json()) as J) : undefined;
  } catch {
    return undefined;
  }
}

const capabilityCache = new Map<string, string[]>();

/**
 * Model capabilities as reported by /api/show, e.g. ["completion", "tools",
 * "thinking"]. Cached per model: this never changes for a given tag, and the
 * refactor path would otherwise pay for it on every invocation.
 */
export async function getCapabilities(endpoint: string, model: string): Promise<string[]> {
  const key = `${endpoint}|${model}`;
  const hit = capabilityCache.get(key);
  if (hit) { return hit; }

  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) { return []; }
    const json = (await res.json()) as { capabilities?: string[] };
    const caps = json.capabilities ?? [];
    capabilityCache.set(key, caps);
    return caps;
  } catch {
    return [];
  }
}

/** Lists locally available model tags; used to warn about instruct-vs-base mistakes. */
export async function listModels(endpoint: string): Promise<string[]> {
  const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`);
  if (!res.ok) { throw new OllamaError(`Ollama returned ${res.status}`); }
  const json = (await res.json()) as { models?: Array<{ name: string }> };
  return (json.models ?? []).map((m) => m.name);
}
