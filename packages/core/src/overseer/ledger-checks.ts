/**
 * The decision-card checks (decision cards spec 2026-10-06, Unit 2). `ledger_add`, `ledger_import`
 * and the agent-block path apply the same checks; a failed check is a 422 with a fixed text and
 * changes nothing. The pure parts live here; the service supplies the project's roots, its agents
 * and the user's messages.
 *
 * 1. Required fields for `decide` and `go`.
 * 2. One decision per card: no range of plan IDs, and not 3 or more plan-style IDs, in the question.
 * 3. Real sources: a plan/doc path exists inside the project (or one of its git worktrees) and does
 *    not escape it; an agent is a thread of this project; a PR/issue is `#123`; a user source is a
 *    checked quote; `overseer` is always allowed.
 * 4. Only the user can decide a `go` item, a user-sourced item, or an item already sent to the user.
 * 5. A project rule needs the user's checked words (ledger_note).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { LedgerKind, LedgerSourceKind } from '../db/ledger.js';

export function cardFieldsError(missing: readonly string[]): string {
  return `A decision card needs: ${missing.join(', ')}. Add them and try again.`;
}
export const ONE_DECISION_ERROR = 'One decision per card. Add each decision on its own.';
export function sourceMissingError(ref: string): string {
  return `The source does not exist in this project: ${ref}.`;
}
export const ONLY_USER_ERROR = 'Only the user can decide this item.';

export const SOURCE_KINDS: readonly LedgerSourceKind[] = ['plan', 'doc', 'agent', 'pr', 'issue', 'user', 'overseer'];

export const CONTEXT_MIN = 20;
export const CONTEXT_MAX = 800;

const F_CONTEXT = `context (${CONTEXT_MIN} to ${CONTEXT_MAX} characters)`;
const F_OPTIONS_DECIDE = 'options (at least 2, each { label, effect })';
const F_OPTIONS_GO = 'options (each { label, effect })';
const F_RECOMMENDATION = 'recommendation (one of the option labels)';

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The card fields as the tools and the agent block pass them. */
export interface CardFieldsInput {
  context?: unknown;
  options?: unknown;
  recommendation?: unknown;
  why?: unknown;
  default?: unknown;
  source?: unknown;
}

/** True when every option is an object with a non-empty label and effect. */
function optionsComplete(options: unknown): options is { label: string; effect: string }[] {
  return Array.isArray(options) && options.every((o) => o && typeof o === 'object' && text((o as any).label) && text((o as any).effect));
}

/** Rule 1: the fields a `decide` or `go` card lacks (or holds in a wrong shape), in a fixed order. [] when complete. */
export function missingCardFields(kind: LedgerKind, input: CardFieldsInput): string[] {
  if (kind !== 'decide' && kind !== 'go') return [];
  const missing: string[] = [];
  const context = text(input.context);
  if (context.length < CONTEXT_MIN || context.length > CONTEXT_MAX) missing.push(F_CONTEXT);

  const raw = input.options;
  const given = Array.isArray(raw) && raw.length > 0;
  let options: { label: string; effect: string }[] = [];
  if (kind === 'decide') {
    if (!given || raw.length < 2 || !optionsComplete(raw)) missing.push(F_OPTIONS_DECIDE);
    else options = raw;
  } else if (given) {
    if (!optionsComplete(raw)) missing.push(F_OPTIONS_GO);
    else options = raw;
  }
  if (options.length) {
    const rec = text(input.recommendation);
    if (!rec || !options.some((o) => text(o.label) === rec)) missing.push(F_RECOMMENDATION);
    if (!text(input.why)) missing.push('why');
  }
  if (!text(input.default)) missing.push('default');
  if (!sourceComplete(input.source)) missing.push('source');
  return missing;
}

/** A source object with a known kind, and a ref for every kind but `overseer`. */
export function sourceComplete(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false;
  const kind = (source as any).kind;
  if (typeof kind !== 'string' || !SOURCE_KINDS.includes(kind as LedgerSourceKind)) return false;
  return kind === 'overseer' || !!text((source as any).ref);
}

// --- rule 2 -------------------------------------------------------------------------------------

/** A plan-style ID: 1 to 3 capital letters, an optional hyphen, 1 to 3 digits (LR-6, D1, Q12). */
const PLAN_ID = '[A-Z]{1,3}-?\\d{1,3}';
const EDGE_BEFORE = '(?<![\\p{L}\\p{N}-])';
const EDGE_AFTER = '(?![\\p{L}\\p{N}])';
const ID_RE = new RegExp(`${EDGE_BEFORE}${PLAN_ID}${EDGE_AFTER}`, 'gu');
const RANGE_RE = new RegExp(
  `${EDGE_BEFORE}${PLAN_ID}\\s*(?:\\.{2,3}|…|-|–|—|\\bto\\b|\\bthrough\\b|\\bthru\\b)\\s*(?:${PLAN_ID}|\\d{1,3})${EDGE_AFTER}`,
  'u',
);

/** Rule 2: the question holds a range of plan IDs (LR-1..LR-26, D1 to D9, D2-D6, Q1–Q6) or names 3+ of them. */
export function holdsSeveralDecisions(question: string): boolean {
  if (RANGE_RE.test(question)) return true;
  return new Set(question.match(ID_RE) ?? []).size >= 3;
}

// --- rule 3 -------------------------------------------------------------------------------------

const escapes = (rel: string) => rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

/**
 * Rule 3 for `plan` and `doc`: the path, relative (or absolute but inside), names an existing file
 * or directory under one of the roots, and neither the path nor a symlink on it leads outside that
 * root. Returns the path relative to the root that holds it, with forward slashes, or null.
 */
export function findProjectPath(ref: string, roots: readonly string[]): string | null {
  if (!ref.trim()) return null;
  for (const root of roots) {
    const base = path.resolve(root);
    const target = path.resolve(base, ref);
    const rel = path.relative(base, target);
    if (!rel || escapes(rel)) continue;
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = fs.realpathSync(base);
      realTarget = fs.realpathSync(target);
    } catch { continue; } // missing
    const realRel = path.relative(realRoot, realTarget);
    if (!realRel || escapes(realRel)) continue; // a symlink that leads out of the project
    return rel.split(path.sep).join('/');
  }
  return null;
}

/** The git worktrees of the repository that holds `dir` (the main one included); [] when it is not a repository. */
export function gitWorktrees(dir: string): string[] {
  try {
    const out = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Rule 3 for `pr` and `issue`: the form `#123`. The daemon does not call GitHub. */
export function isIssueRef(ref: string): boolean {
  return /^#\d+$/.test(ref.trim());
}

// --- rule 4 -------------------------------------------------------------------------------------

/** Rule 4: `ledger_decide_self` must refuse a go item, a user-sourced item, and an item already sent to the user. */
export function onlyUserCanDecide(item: { kind: LedgerKind; sourceKind: LedgerSourceKind | null; sentAt: string | null }): boolean {
  return item.kind === 'go' || item.sourceKind === 'user' || item.sentAt !== null;
}
