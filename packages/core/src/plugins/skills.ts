import fs from 'node:fs';
import path from 'node:path';
import type { MarketplaceService } from './marketplaces.js';

/**
 * Skills (docs/superpowers/specs/2026-11-07-plugins-design.md, section 8): `dir/<id>/` with a
 * `skill.json` and a `SKILL.md`, local or installed from a marketplace. Enabled skills reach a
 * thread's system prompt as text under `## Skill: <name>` with the folder's absolute path, so the
 * model can read the skill's other files. Dispatch never writes into a project for this. A skill
 * is enabled globally (the default) and may be switched off for one project.
 */
export interface SkillRow { id: string; name: string; version: string; description: string | null; harnesses: string[] | null; /** Only these projects get it (skill.json `projects`); null = every project. */ projects: string[] | null; folder: string; install: { marketplace: string; version: string; commit: string; installedAt: string } | null; enabled: boolean; enabledHere?: boolean; text: string; error?: string }
interface State { disabled: string[]; projects: Record<string, { off: string[] }> }

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INSTALL_FILE = '.dispatch-install.json';
/** Longer skill texts are cut: a skill is guidance, not a book; the folder path lets the model read the rest. */
export const SKILL_TEXT_MAX = 32 * 1024;
/** The most a created skill's SKILL.md may hold (coach spec section 4.8). */
export const SKILL_BODY_MAX = 64 * 1024;
export interface SkillDraft { id: string; name: string; description: string; body: string; projects?: string[] }

export class SkillsService {
  constructor(readonly dir: string, private readonly stateFile: string, private readonly markets: MarketplaceService) {}

  /** Every skill, by id; with `sessionId`, `enabledHere` says whether that project gets it. */
  list(sessionId?: string): SkillRow[] {
    let ids: string[] = [];
    try { ids = fs.readdirSync(this.dir).filter((n) => ID_RE.test(n)).sort(); } catch { return []; }
    const state = this.readState();
    const out: SkillRow[] = [];
    for (const id of ids) {
      const folder = path.join(this.dir, id);
      let meta: Record<string, unknown> | null = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(folder, 'skill.json'), 'utf8')) as Record<string, unknown>; } catch { meta = null; }
      let text = '';
      try { text = fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8'); } catch { text = ''; }
      const enabled = !state.disabled.includes(id);
      const projects = Array.isArray(meta?.projects) ? (meta!.projects as unknown[]).filter((p): p is string => typeof p === 'string') : null;
      const row: SkillRow = {
        id, name: typeof meta?.name === 'string' ? meta.name : id, version: typeof meta?.version === 'string' ? meta.version : '0.0.0',
        description: typeof meta?.description === 'string' ? meta.description : null,
        harnesses: Array.isArray(meta?.harnesses) ? (meta!.harnesses as unknown[]).filter((h): h is string => typeof h === 'string') : null,
        projects, folder, install: this.readInstall(folder), enabled, text,
        ...(sessionId !== undefined ? { enabledHere: enabled && !(state.projects[sessionId]?.off ?? []).includes(id) && (!projects || projects.includes(sessionId)) } : {}),
        ...(!meta ? { error: 'no skill.json in the folder' } : !text ? { error: 'no SKILL.md in the folder' } : {}),
      };
      out.push(row);
    }
    return out;
  }

  /** The prompt blocks for a project's thread on one harness. */
  injection(sessionId: string | null, harness: string): string[] {
    const out: string[] = [];
    for (const s of this.list(sessionId ?? undefined)) {
      if (s.error || !s.enabled) continue;
      if (sessionId && s.enabledHere === false) continue;
      if (s.harnesses && !s.harnesses.includes(harness)) continue;
      let folder = s.folder;
      try { folder = fs.realpathSync(s.folder); } catch { /* as listed */ }
      let text = s.text.trim();
      if (text.length > SKILL_TEXT_MAX) text = `${text.slice(0, SKILL_TEXT_MAX)}\n\n[cut: the skill text is longer than ${SKILL_TEXT_MAX} characters; read the rest in ${folder}/SKILL.md]`;
      out.push(`## Skill: ${s.name.split('\n')[0].trim()}\n\nFolder: ${folder}\n\n${text}`);
    }
    return out;
  }

  async install(slug: string, id: string): Promise<SkillRow> {
    if (!ID_RE.test(id)) throw new Error('bad id');
    const m = this.markets.get(slug);
    if (!m) throw new Error('unknown marketplace');
    if (this.list().some((s) => s.id === id)) throw new Error(`"${id}" is already installed`);
    await this.markets.pull(slug);
    const entry = (await this.markets.catalog()).find((e) => e.marketplace === slug && e.kind === 'skill' && e.id === id);
    if (!entry) throw new Error(`"${id}" is not in the marketplace`);
    const commit = await this.markets.head(slug);
    const exported = await this.markets.folderAt(slug, id, commit ?? 'HEAD', 'skill');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.cpSync(exported, path.join(this.dir, id), { recursive: true });
    fs.rmSync(exported, { recursive: true, force: true });
    fs.writeFileSync(path.join(this.dir, id, INSTALL_FILE), JSON.stringify({ marketplace: m.url, version: entry.version, commit: commit ?? '', installedAt: new Date().toISOString() }, null, 2) + '\n');
    return this.list().find((s) => s.id === id)!;
  }

  /**
   * A new local skill from a draft (coach spec section 4.8: the Coach's "Create skill"): writes
   * `<id>/SKILL.md` and `skill.json`, and enables it. Throws 'bad …' for a bad draft and
   * 'already installed' for an id that exists. `projects` limits it to those projects.
   */
  create(d: SkillDraft): SkillRow {
    if (!ID_RE.test(d.id)) throw new Error('bad id: a lower-case slug (letters, digits, dashes), up to 64');
    const name = typeof d.name === 'string' ? d.name.trim() : '';
    if (!name || name.length > 120 || name.includes('\n')) throw new Error('bad name: one line, up to 120 characters');
    const description = typeof d.description === 'string' ? d.description.trim() : '';
    if (description.length > 300) throw new Error('bad description: up to 300 characters');
    if (typeof d.body !== 'string' || !d.body.trim()) throw new Error('bad body: SKILL.md text is required');
    if (Buffer.byteLength(d.body, 'utf8') > SKILL_BODY_MAX) throw new Error(`bad body: at most ${SKILL_BODY_MAX} bytes`);
    if (d.projects !== undefined && !(Array.isArray(d.projects) && d.projects.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 120))) throw new Error('bad projects: a list of project ids');
    if (fs.existsSync(path.join(this.dir, d.id))) throw new Error(`"${d.id}" is already installed`);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(this.dir, `.new-${d.id}-`));
    try {
      const meta: Record<string, unknown> = { id: d.id, name, version: '1.0.0', description: description || null, ...(d.projects && d.projects.length ? { projects: [...new Set(d.projects)] } : {}) };
      fs.writeFileSync(path.join(tmp, 'skill.json'), JSON.stringify(meta, null, 2) + '\n');
      fs.writeFileSync(path.join(tmp, 'SKILL.md'), d.body.replace(/\s+$/, '') + '\n');
      fs.renameSync(tmp, path.join(this.dir, d.id));
    } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
    this.setEnabled(d.id, true);
    return this.list().find((s) => s.id === d.id)!;
  }

  remove(id: string): void {
    if (!ID_RE.test(id) || !this.list().some((s) => s.id === id)) throw new Error('unknown skill');
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    const state = this.readState();
    state.disabled = state.disabled.filter((x) => x !== id);
    for (const p of Object.values(state.projects)) p.off = p.off.filter((x) => x !== id);
    this.writeState(state);
  }

  /** Global when no project is named; for one project otherwise (a project switch never turns a skill on globally). */
  setEnabled(id: string, on: boolean, sessionId?: string): void {
    const state = this.readState();
    if (!sessionId) {
      state.disabled = on ? state.disabled.filter((x) => x !== id) : [...new Set([...state.disabled, id])];
    } else {
      const p = state.projects[sessionId] ?? { off: [] };
      p.off = on ? p.off.filter((x) => x !== id) : [...new Set([...p.off, id])];
      if (p.off.length) state.projects[sessionId] = p; else delete state.projects[sessionId];
    }
    this.writeState(state);
  }

  private readInstall(folder: string): SkillRow['install'] {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(folder, INSTALL_FILE), 'utf8')) as Record<string, unknown>;
      return typeof raw.marketplace === 'string' && typeof raw.version === 'string' ? { marketplace: raw.marketplace, version: raw.version, commit: String(raw.commit ?? ''), installedAt: String(raw.installedAt ?? '') } : null;
    } catch { return null; }
  }
  private readState(): State {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<State>;
      const projects: State['projects'] = {};
      if (raw.projects && typeof raw.projects === 'object') for (const [k, v] of Object.entries(raw.projects)) if (v && Array.isArray((v as { off?: unknown }).off)) projects[k] = { off: (v as { off: unknown[] }).off.filter((x): x is string => typeof x === 'string') };
      return { disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((x): x is string => typeof x === 'string') : [], projects };
    } catch { return { disabled: [], projects: {} }; }
  }
  private writeState(s: State): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  }
}
