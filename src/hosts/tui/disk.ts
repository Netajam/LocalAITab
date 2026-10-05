import { promises as fs } from 'fs';
import * as path from 'path';
import { ConversationHost } from '../../core/harness/conversation';

/** Straight to disk: a terminal has no buffers of its own to keep in step. */
export const diskWorkspace: ConversationHost['workspace'] = {
  read: (file) => fs.readFile(file, 'utf8'),

  async replace(file, at, length, text) {
    const old = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, old.slice(0, at) + text + old.slice(at + length), 'utf8');
  },

  async write(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
  },
};
