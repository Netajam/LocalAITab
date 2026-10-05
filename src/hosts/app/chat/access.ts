import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

/**
 * Reaching files outside the workspace.
 *
 * Two different kinds of access, deliberately. Attaching is something the user
 * does to a file they chose, so it goes anywhere. The agent reads without
 * asking, so it only reaches folders granted to it: localAITab.extraFolders for
 * good, or /allow for the life of the panel.
 */

/** Directories never worth sweeping: dependencies, build output, VCS metadata. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', '.venv']);

/** Expands a leading ~ and makes the path absolute, or returns undefined for a relative one. */
export function absolutePath(p: string): string | undefined {
  const t = p.trim();
  if (t === '~' || t.startsWith('~/')) { return path.join(os.homedir(), t.slice(1)); }
  if (path.isAbsolute(t)) { return path.resolve(t); }
  return undefined;
}

/** How a path is shown: relative inside the workspace, ~-shortened outside it. */
export function displayPath(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri);
  if (rel !== uri.fsPath) { return rel; }
  const home = os.homedir();
  return uri.fsPath.startsWith(home + path.sep) ? '~' + uri.fsPath.slice(home.length) : uri.fsPath;
}

/** localAITab.extraFolders, expanded. Entries that are not absolute are ignored. */
export function configuredFolders(): vscode.Uri[] {
  return vscode.workspace.getConfiguration('localAITab').get<string[]>('extraFolders', [])
    .map(absolutePath)
    .filter((p): p is string => Boolean(p))
    .map((p) => vscode.Uri.file(p));
}

export async function stat(uri: vscode.Uri): Promise<vscode.FileType | undefined> {
  try {
    return (await vscode.workspace.fs.stat(uri)).type;
  } catch {
    return undefined;
  }
}

/**
 * Files under a folder, for folders findFiles cannot see: it only searches
 * workspace folders. Hidden entries and the usual build directories are skipped.
 */
export async function listFolder(dir: vscode.Uri, limit = 500): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  const queue = [dir];
  while (queue.length && out.length < limit) {
    const current = queue.shift()!;
    for (const [name, type] of await sweepable(current)) {
      const uri = vscode.Uri.joinPath(current, name);
      if (type & vscode.FileType.Directory) { queue.push(uri); }
      else if (type & vscode.FileType.File) { out.push(uri); }
    }
  }
  return out.slice(0, limit);
}

/** A folder's entries worth sweeping, sorted by name; none when it cannot be read. */
async function sweepable(dir: vscode.Uri): Promise<[string, vscode.FileType][]> {
  const entries = await Promise.resolve(vscode.workspace.fs.readDirectory(dir)).catch(() => []);
  return entries
    .filter(([name]) => !name.startsWith('.') && !SKIP.has(name))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** The system file dialog, from anywhere on disk. A chosen folder yields the files under it. */
export async function browseFiles(): Promise<vscode.Uri[]> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: 'Attach',
    title: 'Attach files from anywhere',
  });
  const out: vscode.Uri[] = [];
  for (const uri of chosen ?? []) {
    if ((await stat(uri)) === vscode.FileType.Directory) { out.push(...await listFolder(uri)); }
    else { out.push(uri); }
  }
  return out;
}

export async function browseFolder(): Promise<vscode.Uri | undefined> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Allow',
    title: 'Let the agent read this folder',
  });
  return chosen?.[0];
}

/**
 * A multi-select file picker with a title-bar button for leaving the
 * workspace. Resolves to the files chosen either way, or [] if dismissed.
 */
export async function pickFiles(
  uris: vscode.Uri[],
  placeholder: string,
  attached: Set<string>,
): Promise<vscode.Uri[]> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { uri: vscode.Uri }>();
  const browse: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('folder-opened'),
    tooltip: 'Browse outside the workspace...',
  };
  const items = uris
    .map((uri) => ({ label: displayPath(uri), uri }))
    .sort((a, b) => a.label.localeCompare(b.label));

  qp.items = items;
  qp.selectedItems = items.filter((i) => attached.has(i.uri.toString()));
  qp.canSelectMany = true;
  qp.placeholder = placeholder;
  qp.buttons = [browse];

  // Whichever happens first wins; the hide that disposing causes afterwards
  // settles nothing.
  const outcome = await new Promise<'accept' | 'browse' | 'dismiss'>((resolve) => {
    qp.onDidAccept(() => resolve('accept'));
    qp.onDidTriggerButton(() => resolve('browse'));
    qp.onDidHide(() => resolve('dismiss'));
    qp.show();
  });
  const picked = qp.selectedItems.map((i) => i.uri);
  // Closing first: the dialog and the picker cannot both hold focus.
  qp.dispose();
  if (outcome === 'browse') { return browseFiles(); }
  return outcome === 'accept' ? picked : [];
}
