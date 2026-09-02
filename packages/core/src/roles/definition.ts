// Role definitions — the "pets" of the scheduled-roles design
// (docs/superpowers/specs/2026-09-02-scheduled-roles-design.md §1). A role lives at
// ~/.dispatch/roles/<name>/ as plain files so it is model-agnostic, git-backupable,
// and human-editable; the daemon re-reads role.md at every fire so edits are
// inherited by the next incarnation with no re-registration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROLE_AGENT_TYPES = ['planner', 'implementer', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer'] as const;
export const ROLE_AUTHORITIES = ['observe', 'stage', 'stage-deploy'] as const;
export type RoleAuthority = (typeof ROLE_AUTHORITIES)[number];

export interface RoleDefinition {
  name: string;
  dir: string;
  project: string | null;
  global: boolean;
  agentType: string;
  model?: string;
  schedule: unknown;
  tz?: string;
  authority: RoleAuthority;
  wallClockCapMin: number;
  brief: string;
}

/** Flat frontmatter: `key: value`; JSON.parse when the value starts with {,[," or is a
 *  bool/number; else the raw trimmed string. Deliberately not YAML — the schema is flat
 *  and small, and a hand-rolled subset beats a dependency for four keys. */
function parseFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('role.md must start with a --- frontmatter block');
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const cleanLine = line.replace(/\r$/, '');
    if (!cleanLine.trim() || cleanLine.trim().startsWith('#')) continue;
    const i = cleanLine.indexOf(':');
    if (i < 0) throw new Error(`frontmatter line has no colon: "${cleanLine}"`);
    const key = cleanLine.slice(0, i).trim();
    const rawVal = cleanLine.slice(i + 1).trim();
    if (/^[{["]/.test(rawVal)) {
      try { fm[key] = JSON.parse(rawVal); } catch { throw new Error(`frontmatter "${key}" is not valid JSON`); }
    } else if (rawVal === 'true' || rawVal === 'false') fm[key] = rawVal === 'true';
    else if (rawVal !== '' && !Number.isNaN(Number(rawVal))) fm[key] = Number(rawVal);
    else fm[key] = rawVal;
  }
  const body = m[2].replace(/\r\n/g, '\n').trim();
  return { fm, body };
}

export function parseRoleMd(name: string, dir: string, raw: string): RoleDefinition {
  const { fm, body } = parseFrontmatter(raw);
  if (typeof fm.name === 'string' && fm.name !== name) throw new Error(`frontmatter name "${fm.name}" does not match dir name "${name}"`);

  // Validate required fields first
  if (fm.schedule === undefined) throw new Error('schedule is required');
  const agentType = String(fm.agentType ?? '');
  if (!(ROLE_AGENT_TYPES as readonly string[]).includes(agentType)) throw new Error(`unknown agentType "${agentType}"`);

  // Then validate optional fields with defaults
  const authority = (fm.authority ?? 'stage') as RoleAuthority;
  if (!(ROLE_AUTHORITIES as readonly string[]).includes(authority)) throw new Error(`unknown authority "${String(fm.authority)}"`);

  // Then validate project binding
  const global = fm.global === true;
  const project = global ? null : typeof fm.project === 'string' && fm.project ? fm.project : null;
  if (!global && !project) throw new Error('a non-global role needs a project binding (or global: true)');

  const cap = typeof fm.wallClockCapMin === 'number' && fm.wallClockCapMin > 0 ? fm.wallClockCapMin : 45;
  return {
    name, dir, project, global, agentType,
    model: typeof fm.model === 'string' && fm.model ? fm.model : undefined,
    schedule: fm.schedule,
    tz: typeof fm.tz === 'string' && fm.tz ? fm.tz : undefined,
    authority, wallClockCapMin: cap, brief: body,
  };
}

export function rolesRootDir(): string {
  return process.env.DISPATCH_ROLES_DIR || path.join(os.homedir(), '.dispatch', 'roles');
}

export function listRoles(root: string = rolesRootDir()): { roles: RoleDefinition[]; errors: { name: string; error: string }[] } {
  const roles: RoleDefinition[] = [];
  const errors: { name: string; error: string }[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { roles, errors }; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      const raw = fs.readFileSync(path.join(dir, 'role.md'), 'utf8');
      roles.push(parseRoleMd(e.name, dir, raw));
    } catch (err) {
      errors.push({ name: e.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  roles.sort((a, b) => a.name.localeCompare(b.name));
  return { roles, errors };
}

export function readRoleMemory(dir: string): string {
  try { return fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'); } catch { return ''; }
}

export function readRunLogTail(dir: string, n: number): string[] {
  try {
    const lines = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

export function appendRunLog(dir: string, entry: object): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(entry) + '\n');
}
