#!/usr/bin/env node
import { parseArgs, USAGE } from './options';
import { Session } from './session';
import { Transcript } from './transcript';
import { SESSIONS_DIR } from '../../core/harness/sessions';

/**
 * localaitab in a terminal: agent and operator mode without the editor. With a
 * task on the command line it runs that once and exits, so it can be scripted.
 */
async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), process.cwd());
  if ('help' in parsed) {
    console.log(USAGE);
    return 0;
  }
  if ('error' in parsed) {
    console.error(`localaitab: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  const o = parsed.options;
  // Checked before the terminal is taken over, so the error lands in the shell.
  if (o.resume && !(await new Transcript(o.projectsDir, o.root, { appendLine() {} }, SESSIONS_DIR).has(o.resume))) {
    console.error(`localaitab: no conversation ${o.resume} in ${o.root}`);
    return 1;
  }

  const session = new Session(o);
  try {
    if (!parsed.task) {
      await session.repl();
      return 0;
    }
    await session.refreshSkills();
    if (!(await session.reopen())) { return 1; }
    return (await session.run(parsed.task)) ? 0 : 1;
  } finally {
    session.close();
  }
}

main().then((code) => process.exit(code));
