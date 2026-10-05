import * as vscode from 'vscode';
import * as os from 'os';
import { DEFAULT_SKILL_PATHS, SKILL_NAME, skillRoots } from '../../../core/harness/skills/skills';

/**
 * Writing a new skill from the palette, into one of the localAITab.skillPaths
 * folders. Finding and running skills is the conversation's job.
 */

function configuredRoots(): string[] {
  const paths = vscode.workspace.getConfiguration('localAITab').get<string[]>('skillPaths', DEFAULT_SKILL_PATHS);
  return skillRoots(paths, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
}

/** Asks for a name and location, writes a SKILL.md skeleton, and opens it. */
export async function scaffoldSkill(): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Skill name: lowercase letters, digits and hyphens. It becomes the /command.',
    placeHolder: 'review-pr',
    validateInput: (v) => SKILL_NAME.test(v) ? undefined : 'Lowercase letters, digits and hyphens only.',
  });
  if (!name) { return; }

  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  const picked = await vscode.window.showQuickPick(
    configuredRoots().map((p) => rootItem(vscode.Uri.file(p), ws)),
    { placeHolder: `Where should /${name} live?` },
  );
  if (!picked) { return; }

  const file = vscode.Uri.joinPath(picked.uri, name, 'SKILL.md');
  const exists = await Promise.resolve(vscode.workspace.fs.stat(file)).then(() => true, () => false);
  if (!exists) {
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(skillSkeleton(name)));
  }
  await vscode.window.showTextDocument(file);
}

/** A skill root as a quick pick entry: workspace roots shown relative, the rest from ~. */
function rootItem(uri: vscode.Uri, ws: vscode.Uri | undefined): vscode.QuickPickItem & { uri: vscode.Uri } {
  if (ws && uri.fsPath.startsWith(ws.fsPath + '/')) {
    return { label: vscode.workspace.asRelativePath(uri), description: 'this workspace', uri };
  }
  return { label: uri.fsPath.replace(os.homedir(), '~'), description: 'every workspace', uri };
}

function skillSkeleton(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: What this skill does and when to use it. The agent decides from this line alone.',
    'argument-hint: "[what to pass after the command]"',
    '---',
    '',
    `# ${name}`,
    '',
    'Step-by-step instructions for the model. $ARGUMENTS is replaced by whatever',
    `follows /${name} in the chat.`,
    '',
  ].join('\n');
}
