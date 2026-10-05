import * as vscode from 'vscode';

/**
 * Post-edit verification using whatever language server is already running.
 *
 * There is no way to type-check a snippet in isolation from an extension, so
 * "does this still compile" is answered by applying the edit and then reading
 * the diagnostics the language server publishes for the real file.
 */

export interface ErrorSnapshot {
  /** Stable identity for a diagnostic, so pre-existing errors are not blamed on us. */
  keys: Set<string>;
  diagnostics: vscode.Diagnostic[];
}

const keyOf = (d: vscode.Diagnostic): string =>
  `${d.source ?? ''}|${typeof d.code === 'object' ? d.code.value : d.code ?? ''}|${d.message}`;

export function snapshotErrors(uri: vscode.Uri): ErrorSnapshot {
  const diagnostics = vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);

  return { keys: new Set(diagnostics.map(keyOf)), diagnostics };
}

/**
 * Errors present now that were not present in `before`.
 *
 * Compared by source/code/message rather than by range: an edit shifts line
 * numbers, so position-based comparison would report every untouched error
 * below the edit as new.
 */
export function newErrorsSince(before: ErrorSnapshot, uri: vscode.Uri): vscode.Diagnostic[] {
  return snapshotErrors(uri).diagnostics.filter((d) => !before.keys.has(keyOf(d)));
}

/**
 * Waits for the language server to finish republishing diagnostics for a file.
 *
 * Servers emit in bursts after an edit, so this settles on a quiet period
 * rather than taking the first event, and gives up after `timeoutMs` for
 * languages with no server attached at all.
 */
export function waitForDiagnostics(uri: vscode.Uri, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const target = uri.toString();
    let settled = false;

    const finish = (): void => {
      if (settled) { return; }
      settled = true;
      sub.dispose();
      clearTimeout(quiet);
      clearTimeout(hard);
      resolve();
    };

    // Resolve once diagnostics have stopped arriving for a short beat.
    let quiet = setTimeout(finish, Math.min(600, timeoutMs));
    const hard = setTimeout(finish, timeoutMs);

    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (!e.uris.some((u) => u.toString() === target)) { return; }
      clearTimeout(quiet);
      quiet = setTimeout(finish, 400);
    });
  });
}

/** Where a replacement ends, given where it starts and what was inserted. */
export function endOfInsertion(start: vscode.Position, text: string): vscode.Position {
  const lines = text.split('\n');
  return lines.length === 1
    ? new vscode.Position(start.line, start.character + text.length)
    : new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1].length);
}

export function describeErrors(diagnostics: vscode.Diagnostic[], limit = 10): string {
  return diagnostics
    .slice(0, limit)
    .map((d) => `line ${d.range.start.line + 1}: ${d.message}`)
    .join('\n');
}
