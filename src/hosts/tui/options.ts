import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Settings, Mode } from '../../core/harness/conversation';
import { PROJECTS_DIR } from '../../core/harness/sessions';

/**
 * Everything a terminal session is configured by. The names and defaults
 * match the extension's localAITab.* settings, so a value can be carried over
 * from one to the other unchanged.
 */
export interface Options extends Settings {
  root: string;
  extraRoots: string[];
  mode: Mode;
  /** What @mentions may attach to one message, in characters. */
  contextMaxChars: number;
  /** Unset means the harness's default skill folders. */
  skillPaths?: string[];
  /** Where conversations are saved, one folder per workspace, as Claude Code's ~/.claude/projects. */
  projectsDir: string;
  /** Start by reopening the latest conversation in this workspace. */
  continue: boolean;
  /** Start by reopening this conversation, by its session id. */
  resume?: string;
}

const DEFAULTS: Omit<Options, 'root' | 'extraRoots'> = {
  mode: 'agent',
  contextMaxChars: 48000,
  projectsDir: PROJECTS_DIR,
  continue: false,
  endpoint: 'http://localhost:11434',
  model: 'qwen3.6:35b-a3b-coding',
  keepAlive: '30m',
  chatMaxTokens: 2048,
  chatTemperature: 0.3,
  chatHistoryTurns: 8,
  agentMaxSteps: 8,
  agentTemperature: 0.2,
  agentMaxReadChars: 12000,
  agentMaxSearchLines: 25,
  operatorMaxSteps: 30,
  operatorTemperature: 0.2,
  operatorCommandTimeout: 120,
  operatorMaxOutputChars: 8000,
};

export const CONFIG_FILE = path.join(os.homedir(), '.localaitab', 'config.json');

export const USAGE = `usage: localaitab [options] [task]

  -C, --cwd <dir>       workspace folder (default: the current directory)
  -m, --model <name>    Ollama model
  -e, --endpoint <url>  Ollama endpoint
  -c, --continue        reopen the latest conversation in this folder
  -r, --resume <id>     reopen that conversation in this folder, by its session id
      --chat            start in chat mode (answers only, no tools)
      --operator        start in operator mode (edits land, commands run)
      --allow <dir>     also let the agent read a folder outside the workspace
  -h, --help            show this help

With a task, runs it once and exits; without one, starts a session.
Defaults can be set in ${CONFIG_FILE.replace(os.homedir(), '~')}, using the
extension's setting names without "localAITab." (model, agentMaxSteps, ...).`;

export type Parsed = { options: Options; task: string } | { help: true } | { error: string };

export function parseArgs(argv: string[], cwd: string): Parsed {
  const file = readConfig();
  if ('error' in file) { return file; }

  const o: Options = { ...DEFAULTS, ...file, root: cwd, extraRoots: [] };
  const task: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { return { help: true }; }
    if (!a.startsWith('-')) { task.push(a); continue; }
    const flag = FLAGS[a];
    if (!flag) { return { error: `unknown option ${a}` }; }
    const value = flag.takesValue ? argv[++i] : '';
    if (value === undefined) { return { error: `${a} needs a value` }; }
    flag.apply(o, value, cwd);
  }
  return { options: o, task: task.join(' ') };
}

interface Flag { takesValue: boolean; apply(o: Options, value: string, cwd: string): void }

const withValue = (apply: Flag['apply']): Flag => ({ takesValue: true, apply });
const cwdFlag = withValue((o, v, cwd) => { o.root = path.resolve(cwd, v); });
const modelFlag = withValue((o, v) => { o.model = v; });
const endpointFlag = withValue((o, v) => { o.endpoint = v; });

const FLAGS: Record<string, Flag> = {
  '-C': cwdFlag, '--cwd': cwdFlag,
  '-m': modelFlag, '--model': modelFlag,
  '-e': endpointFlag, '--endpoint': endpointFlag,
  '-c': { takesValue: false, apply: (o) => { o.continue = true; } },
  '--continue': { takesValue: false, apply: (o) => { o.continue = true; } },
  '-r': withValue((o, v) => { o.resume = v; }),
  '--resume': withValue((o, v) => { o.resume = v; }),
  '--chat': { takesValue: false, apply: (o) => { o.mode = 'chat'; } },
  '--operator': { takesValue: false, apply: (o) => { o.mode = 'operator'; } },
  '--allow': withValue((o, v, cwd) => { o.extraRoots.push(expandHome(v, cwd)); }),
};

/** The config file, if there is one. Unknown keys are ignored rather than refused. */
function readConfig(): Partial<Options> | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return {};
  }
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(json).filter(([k]) => k in DEFAULTS || k === 'skillPaths')) as Partial<Options>;
  } catch (err) {
    return { error: `${CONFIG_FILE}: ${(err as Error).message}` };
  }
}

function expandHome(p: string, cwd: string): string {
  return path.resolve(cwd, p.replace(/^~(?=\/|$)/, os.homedir()));
}
