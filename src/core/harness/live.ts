import { execFileSync } from 'child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import { SESSIONS_DIR, VERSION } from './sessions';
import type { Log } from './tools';

/**
 * The live file of a running localaitab: `sessions/<pid>.json`, in the shape of
 * Claude Code's `~/.claude/sessions/<pid>.json`, so a session monitor
 * can tell that a localaitab agent is running, where, on which session, and
 * whether it is working, waiting for the person, or done.
 *
 * Written whole each time through a temporary file and a rename, so a reader
 * never sees half of one. Removed when the process leaves; one a crash left
 * behind names a pid that is gone or started later, which is how a reader
 * tells.
 */

/** `busy` from a prompt until its reply, `waiting` while a command asks approval, `idle` otherwise. */
export type LiveStatus = 'busy' | 'waiting' | 'idle';

export interface LiveOptions {
  /** `localaitab-tui` or `localaitab-vscode`. */
  entrypoint: string;
  cwd: string;
  sessionId: string;
  /** Record the tmux pane the process runs in, when it runs in one. */
  tmux?: boolean;
  /** Where the file goes; SESSIONS_DIR unless a test says otherwise. */
  dir?: string;
  log: Log;
}

export class LiveSession {
  readonly file: string;
  private readonly fields: Record<string, unknown>;
  private closed = false;
  private readonly onExit = () => this.close();

  constructor(private readonly o: LiveOptions) {
    const now = Date.now();
    const dir = o.dir ?? SESSIONS_DIR;
    this.file = path.join(dir, `${process.pid}.json`);
    this.fields = {
      pid: process.pid,
      sessionId: o.sessionId,
      cwd: o.cwd,
      startedAt: now,
      procStart: procStart(process.pid),
      kind: 'interactive',
      entrypoint: o.entrypoint,
      name: undefined,
      status: 'idle',
      statusUpdatedAt: now,
      updatedAt: now,
      tmux: o.tmux ? tmuxPane({ log: o.log }) : undefined,
      version: VERSION,
    };
    try { mkdirSync(dir, { recursive: true }); } catch { /* the write says why */ }
    this.write();
    // A clean exit that skips close(), such as process.exit() from anywhere.
    process.once('exit', this.onExit);
  }

  get status(): LiveStatus { return this.fields.status as LiveStatus; }

  setStatus(status: LiveStatus): void {
    if (status === this.fields.status) { return; }
    this.set({ status, statusUpdatedAt: Date.now() });
  }

  /** Follows the current session: its id, and its title once it has one. */
  setSession(sessionId: string, name?: string): void {
    this.set({ sessionId, name });
  }

  setCwd(cwd: string): void {
    this.set({ cwd });
  }

  /** Removes the file. Safe to call more than once. */
  close(): void {
    if (this.closed) { return; }
    this.closed = true;
    process.removeListener('exit', this.onExit);
    try { rmSync(this.file, { force: true }); } catch { /* already gone */ }
  }

  private set(changes: Record<string, unknown>): void {
    if (this.closed) { return; }
    Object.assign(this.fields, changes, { updatedAt: Date.now() });
    this.write();
  }

  /** The whole file, through a temporary one renamed over it. Synchronous: it is small, and order matters. */
  private write(): void {
    const tmp = `${this.file}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.fields), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      this.o.log.appendLine(`[live] could not write ${this.file}: ${(err as Error).message}`);
      try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    }
  }
}

/**
 * When `pid` started, exactly as `ps -o lstart=` prints it in UTC with the C
 * locale ("Tue Sep 29 12:23:50 2026"), which is what a monitor compares with
 * `ps` to tell this process from a later one given the same pid.
 */
export function procStart(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Runs tmux with `args` and returns what it printed; throws when it fails or takes too long. */
export type TmuxRunner = (args: string[]) => string;

/** The real tmux, given two seconds: a live file waits on this at startup. */
const runTmux: TmuxRunner = (args) => execFileSync('tmux', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
});

/**
 * `session:@window.%pane` for the tmux pane this process runs in; undefined
 * outside tmux, or when tmux does not answer, which `log` is told about so a
 * slow tmux is not mistaken for no tmux. `run` stands in for tmux in tests.
 */
export function tmuxPane(o: { run?: TmuxRunner; log?: Log } = {}): string | undefined {
  const pane = process.env.TMUX_PANE;
  if (!pane) { return undefined; }
  try {
    return (o.run ?? runTmux)(['display', '-p', '-t', pane, '#S:#{window_id}.#{pane_id}']).trim() || undefined;
  } catch (err) {
    o.log?.appendLine(`[live] tmux did not name pane ${pane}: ${why(err)}`);
    return undefined;
  }
}

/** The shortest account of a failed run: its code (ETIMEDOUT, ENOENT), its signal, or its message. */
function why(err: unknown): string {
  const e = err as { code?: string; signal?: string; message?: string };
  return e.code ?? e.signal ?? String(e.message);
}
