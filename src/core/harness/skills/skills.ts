import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Skill, parseSkill, renderCatalog } from './skillFormat';

export { Skill, SKILL_NAME, expandSkill } from './skillFormat';

/**
 * Finds skills on disk.
 *
 * Each skill path is a folder of skill folders. Only localaitab's own folders
 * are read by default, so skills written for other harnesses do not reach the
 * model unless asked for: a skills folder may have a `skills.json` beside it
 * (`.localaitab/skills.json` next to `.localaitab/skills`) that references skill
 * folders kept elsewhere, by path, without copying them. Earlier entries win
 * a name collision, which puts the workspace ahead of the home directory, and
 * a folder's own skills ahead of the ones it references.
 */

export const DEFAULT_SKILL_PATHS = ['.localaitab/skills', '~/.localaitab/skills'];

export interface LoadedSkills {
  skills: Skill[];
  /** Skipped SKILL.md files and references, and why, for the log. */
  problems: string[];
}

/** Bundled files beyond this are not listed; a skill is not a repository. */
const MAX_FILES = 50;

/**
 * The configured skill paths as absolute folders. Relative ones sit in the
 * workspace, so without one they are dropped.
 */
export function skillRoots(paths: string[], workspace: string | undefined): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (p.startsWith('~/')) { out.push(os.homedir() + p.slice(1)); }
    else if (p.startsWith('/')) { out.push(p); }
    else if (workspace) { out.push(path.join(workspace, p)); }
  }
  return out;
}

/** A skill folder to load, whether the model may pick it on its own, and whether a skills.json named it. */
interface Source { dir: string; model: boolean; referenced: boolean }

export async function loadSkills(roots: string[]): Promise<LoadedSkills> {
  const skills: Skill[] = [];
  const problems: string[] = [];
  const seen = new Map<string, string>();

  for (const root of roots) {
    const refs = await references(`${root}.json`, problems);
    for (const source of [...await ownSkills(root), ...refs]) {
      const loaded = await loadSkill(source);
      if (!loaded) { continue; }
      if ('error' in loaded) { problems.push(loaded.error); continue; }
      const earlier = seen.get(loaded.name);
      if (earlier) { problems.push(`${source.dir}: shadowed by ${earlier}`); continue; }
      seen.set(loaded.name, source.dir);
      skills.push(loaded);
    }
  }
  return { skills, problems };
}

/** The skill folders inside a skills folder, by name. */
async function ownSkills(root: string): Promise<Source[]> {
  const entries = await readDir(root);
  return entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ dir: path.join(root, e.name), model: true, referenced: false }));
}

/**
 * The skills a `skills.json` references: `{"skills": [...]}`, each entry the
 * path of a skill folder, or `{"path": ..., "model": false}` for one only the
 * user may run. Relative paths are read from the file's own folder, `~` from
 * home. A missing file references nothing; a malformed one says why.
 */
async function references(file: string, problems: string[]): Promise<Source[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  let entries: unknown;
  try {
    entries = (JSON.parse(raw) as { skills?: unknown }).skills;
  } catch (err) {
    problems.push(`${file}: ${(err as Error).message}`);
    return [];
  }
  if (!Array.isArray(entries)) { problems.push(`${file}: expected {"skills": [...]}`); return []; }

  const sources: Source[] = [];
  for (const entry of entries) {
    const ref = typeof entry === 'string' ? { path: entry } : (entry as { path?: unknown; model?: unknown });
    if (typeof ref.path !== 'string') { problems.push(`${file}: an entry has no "path"`); continue; }
    const dir = path.resolve(path.dirname(file), ref.path.replace(/^~(?=\/|$)/, os.homedir()));
    sources.push({ dir, model: ref.model !== false, referenced: true });
  }
  return sources;
}

/**
 * One skill folder's SKILL.md, parsed. Undefined for a folder that holds no
 * SKILL.md, which is simply not a skill.
 */
async function loadSkill(source: Source): Promise<Skill | { error: string } | undefined> {
  const file = path.join(source.dir, 'SKILL.md');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    // Inside a skills folder that is an ordinary folder; a reference was meant to be a skill.
    return source.referenced ? { error: `${source.dir}: referenced as a skill, but has no SKILL.md` } : undefined;
  }
  const parsed = parseSkill(raw, path.basename(source.dir));
  if ('error' in parsed) { return { error: `${file}: ${parsed.error}` }; }
  return { ...parsed, modelInvocable: parsed.modelInvocable && source.model, dir: source.dir, files: await listFiles(source.dir) };
}

async function readDir(folder: string) {
  try {
    return await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return []; // most configured roots will not exist, which is fine
  }
}

/** Files under a skill folder other than SKILL.md, relative to it. */
async function listFiles(dir: string, prefix = '', out: string[] = []): Promise<string[]> {
  for (const entry of await readDir(path.join(dir, prefix))) {
    if (out.length >= MAX_FILES) { break; }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name.startsWith('.') || rel === 'SKILL.md') { continue; }
    if (entry.isDirectory()) { await listFiles(dir, rel, out); }
    else { out.push(rel); }
  }
  return out;
}

/**
 * Reads a file bundled with a skill, refusing anything that resolves outside
 * the skill's folder.
 */
async function readSkillFile(skill: Skill, rel: string): Promise<string | undefined> {
  const file = path.join(skill.dir, rel.replace(/^\/+/, ''));
  if (!file.startsWith(skill.dir + '/')) { return undefined; }
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** What the agent needs to use skills on its own: the catalog, and load_skill behind it. */
export function agentSkills(skills: Skill[]): {
  skillCatalog?: string;
  loadSkill?: (name: string, file: string, maxChars: number) => Promise<{ ok: boolean; text: string }>;
} {
  // Offered for any skill, not only listed ones: a skill the user invoked by
  // hand may still bundle files the model needs to read.
  if (!skills.length) { return {}; }
  return {
    skillCatalog: renderCatalog(skills.filter((s) => s.modelInvocable)) || undefined,
    loadSkill: (name, file, maxChars) => loadForAgent(skills, name, file, maxChars),
  };
}

async function loadForAgent(skills: Skill[], name: string, file: string, maxChars: number): Promise<{ ok: boolean; text: string }> {
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    const names = skills.map((s) => s.name).join(', ');
    return { ok: false, text: `ERROR: no skill named "${name}". Available: ${names}.` };
  }

  const files = skill.files.length
    ? `\n\nBundled files, readable with load_skill and file: ${skill.files.join(', ')}`
    : '';
  if (!file) { return { ok: true, text: skill.body + files }; }

  const text = await readSkillFile(skill, file);
  if (text !== undefined) {
    return { ok: true, text: text.length > maxChars ? text.slice(0, maxChars) + '\n\n[truncated]' : text };
  }
  // Models guess a file name on the first call. Handing back the instructions
  // spares a step of the capped loop that an error would spend.
  return { ok: true, text: `(${skill.name} has no file "${file}"; its instructions follow.)\n\n${skill.body}${files}` };
}
