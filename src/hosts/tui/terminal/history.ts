import { readFileSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Messages sent in earlier sessions, so ↑ and the inline suggestions reach
 * back past this one. One JSON string per line, newest last, capped.
 */

const FILE = process.env.LOCALAITAB_HISTORY || path.join(os.homedir(), '.localaitab', 'history');
const KEEP = 500;

export function loadHistory(): string[] {
  try {
    return readFileSync(FILE, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as string]; } catch { return []; }
    }).slice(-KEEP);
  } catch {
    return [];
  }
}

/** Writes the whole list back, trimmed; a failure only costs the history. */
export async function saveHistory(history: string[]): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, history.slice(-KEEP).map((h) => JSON.stringify(h)).join('\n') + '\n', 'utf8');
  } catch {
    // Read-only home, full disk: history is a convenience, not worth an error.
  }
}
