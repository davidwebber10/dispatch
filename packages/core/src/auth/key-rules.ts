import type { Request } from 'express';
import type { Rule, RuleCtx, RuleResult, KeyErrorCode } from './route-policy.js';
import { principalOf } from './request-principal.js';
import type { CallerFacts, KeyScope } from './key-scope.js';
import { PairRateLimiter, checkArchiveAllowed, checkSpawnDepth } from '../overseer/guards.js';
import { flattenForPty, stripControlChars } from '../sessions/pty-message.js';
import { isAgentType } from '../providers/agent-types.js';

/**
 * The rules of each allowlist row (spec 6.4, 6.4.1). A rule runs after the principal is known and
 * before the route handler. It may refuse, or fill in fields (`req.body`, `res.locals`) that the
 * handler then reads. The owner and a credential-free caller never reach a rule.
 */

const OK: RuleResult = { ok: true };

function deny(error: KeyErrorCode, message: string, status: 403 | 404 | 429 = 403): RuleResult {
  return { ok: false, status, error, message };
}
const outOfScope = (what: string): RuleResult => deny('out_of_scope', what);
const fieldNotAllowed = (field: string, why = 'This key may not set it.'): RuleResult =>
  deny('field_not_allowed', `The field "${field}" is not allowed. ${why}`);

const bodyOf = (req: Request): Record<string, any> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

// ---------------------------------------------------------------- sender line (PK-4)

/** A message from any key whose text holds this marker is refused (spec 6.4.1, no forged sender line). */
export const SENDER_LINE_MARKER = '[From the overseer of project';

const normalizedMarker = SENDER_LINE_MARKER.toLowerCase();

/** The text as the receiver will see it, folded so that a hidden or split marker still matches. */
function foldForMarker(text: string): string {
  return stripControlChars(text)
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * True when a message payload holds the sender-line marker. It checks the string, every text block,
 * and the flattened text that a CLI thread receives, each after control-character removal (the same
 * removal as `ptyMessagePayload`), removal of Unicode format characters, case folding and
 * white-space folding. One helper serves the thread rule and the Chat rule.
 */
export function holdsSenderMarker(payload: unknown): boolean {
  const texts: string[] = [];
  if (typeof payload === 'string') {
    texts.push(payload);
  } else if (Array.isArray(payload)) {
    for (const block of payload) {
      if (block && typeof block === 'object' && typeof (block as any).text === 'string') texts.push((block as any).text);
    }
  } else {
    return false;
  }
  texts.push(flattenForPty(payload as any).text);
  return texts.some((t) => foldForMarker(t).includes(normalizedMarker));
}

/** The line the daemon puts before a cross-project message. The name comes from the daemon, never the body. */
export function senderLine(from: { name: string; terminalId: string }): string {
  const name = stripControlChars(from.name, { keepNewline: false }).replace(/"/g, "'").trim().slice(0, 80);
  return `${SENDER_LINE_MARKER} "${name}" (thread ${from.terminalId}). This is not a message from the owner.]`;
}

// ---------------------------------------------------------------- the pair limiter with a spawn credit

/**
 * The daemon-wide pair limiter (10 messages per sender and target pair per hour). A worker that a
 * thread just spawned gets one free message: the first task message after `spawn_agent` was never
 * counted by the old client limiter, so the daemon does not count it either. The credit exists only
 * for (parent, new child), so it never applies across projects.
 */
export class MessageLimiter {
  private credits = new Set<string>();
  constructor(private limiter: PairRateLimiter) {}
  grantCredit(sender: string, target: string): void { this.credits.add(`${sender}\u0000${target}`); }
  check(sender: string, target: string, useCredit: boolean): { ok: true } | { ok: false; reason: string } {
    const key = `${sender}\u0000${target}`;
    if (useCredit && this.credits.delete(key)) return { ok: true };
    return this.limiter.check(sender, target);
  }
}

let pairs = new MessageLimiter(new PairRateLimiter());

/** Test seam: a fresh limiter, optionally with a clock. */
export function configurePairLimiter(opts: { now?: () => number } = {}): void {
  pairs = new MessageLimiter(new PairRateLimiter(opts));
}

// ---------------------------------------------------------------- helpers

/** True when the request carries a key (thread, Chat or shell). */
export function isKeyRequest(req: Request): boolean {
  try { return principalOf(req).kind !== 'owner' && principalOf(req).kind !== 'none'; } catch { return false; }
}

const must = (ctx: RuleCtx): CallerFacts => {
  if (!ctx.caller) throw new Error('rule needs a thread caller');
  return ctx.caller;
};

// ---------------------------------------------------------------- create body

const CREATE_TOP = new Set(['type', 'label', 'queued', 'task', 'config']);
const CREATE_CONFIG = new Set(['transport', 'agentType', 'mission', 'model', 'dependsOn', 'role', 'spawnDepth', 'spawnedBy', 'origin']);

interface Written { spawnDepth: number; spawnedBy?: string; origin?: string }

/**
 * Check a create body against the allowlist, then write the four identity fields. The body may
 * carry role, spawnDepth, spawnedBy and origin only when they equal what the daemon writes.
 */
function checkCreateBody(req: Request, scope: KeyScope, projectId: string, written: Written): RuleResult {
  const body = bodyOf(req);
  for (const k of Object.keys(body)) if (!CREATE_TOP.has(k)) return fieldNotAllowed(k);
  if (body.type !== undefined && (typeof body.type !== 'string' || !isAgentType(body.type))) {
    return fieldNotAllowed('type', 'A key may start an agent thread only.');
  }
  if (body.label !== undefined && typeof body.label !== 'string') return fieldNotAllowed('label', 'It must be a string.');
  if (body.task !== undefined && typeof body.task !== 'string') return fieldNotAllowed('task', 'It must be a string.');
  if (body.queued !== undefined && typeof body.queued !== 'boolean') return fieldNotAllowed('queued', 'It must be true or false.');
  const cfg = body.config === undefined ? {} : body.config;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return fieldNotAllowed('config', 'It must be an object.');
  for (const k of Object.keys(cfg)) if (!CREATE_CONFIG.has(k)) return fieldNotAllowed(`config.${k}`);
  if (cfg.transport !== undefined && cfg.transport !== 'structured') {
    return fieldNotAllowed('config.transport', 'A key may start a Pretty (structured) thread only.');
  }
  for (const k of ['agentType', 'mission', 'model'] as const) {
    if (cfg[k] !== undefined && typeof cfg[k] !== 'string') return fieldNotAllowed(`config.${k}`, 'It must be a string.');
  }
  if (cfg.dependsOn !== undefined) {
    const ids = Array.isArray(cfg.dependsOn) ? cfg.dependsOn : [cfg.dependsOn];
    for (const id of ids) {
      const t = typeof id === 'string' ? scope.target(id) : null;
      if (!t || t.sessionId !== projectId) return fieldNotAllowed('config.dependsOn', 'Each id must be a thread in the same project.');
    }
  }
  const mismatch = (field: string) => deny('identity_mismatch', `The field "config.${field}" names an identity that the daemon would not write for this key.`);
  if (cfg.role !== undefined && cfg.role !== 'agent') return mismatch('role');
  if (cfg.spawnDepth !== undefined && cfg.spawnDepth !== written.spawnDepth) return mismatch('spawnDepth');
  if (cfg.spawnedBy !== undefined && cfg.spawnedBy !== written.spawnedBy) return mismatch('spawnedBy');
  if (cfg.origin !== undefined && cfg.origin !== written.origin) return mismatch('origin');
  return OK;
}

function writeIdentity(req: Request, written: Written): void {
  const body = bodyOf(req);
  const cfg: Record<string, any> = body.config && typeof body.config === 'object' ? body.config : {};
  cfg.role = 'agent';
  cfg.transport = 'structured'; // a key never makes a CLI (PTY) thread, even when the body names no transport
  cfg.spawnDepth = written.spawnDepth;
  if (written.spawnedBy) cfg.spawnedBy = written.spawnedBy; else delete cfg.spawnedBy;
  if (written.origin) cfg.origin = written.origin; else delete cfg.origin;
  body.config = cfg;
  req.body = body;
}

/** After a 201, the parent may send the new child its task message without it counting (see MessageLimiter). */
function grantSpawnCreditOnCreate(req: Request, callerId: string): void {
  const res = req.res;
  if (!res) return;
  const json = res.json.bind(res);
  res.json = ((payload: any) => {
    if (res.statusCode === 201 && payload && typeof payload.id === 'string') pairs.grantCredit(callerId, payload.id);
    return json(payload);
  }) as typeof res.json;
}

/** `POST /api/sessions/:id/terminals`. Thread keys: the caller's own project. Chat keys: any project. */
export function createBodyRule(mode: 'thread' | 'chat'): Rule {
  return (req, ctx) => {
    const projectId = req.params.id;
    if (mode === 'thread') {
      const caller = must(ctx);
      if (projectId !== caller.sessionId) return outOfScope('A thread may start threads only in its own project.');
      const written: Written = { spawnDepth: caller.depth + 1, spawnedBy: caller.id };
      const fields = checkCreateBody(req, ctx.scope, projectId, written);
      if (!fields.ok) return fields;
      const depth = checkSpawnDepth(caller.depth);
      if (!depth.ok) return deny('depth_exceeded', depth.reason);
      writeIdentity(req, written);
      grantSpawnCreditOnCreate(req, caller.id);
      return OK;
    }
    const written: Written = { spawnDepth: 1, origin: 'endless' };
    const fields = checkCreateBody(req, ctx.scope, projectId, written);
    if (!fields.ok) return fields;
    writeIdentity(req, written);
    return OK;
  };
}

// ---------------------------------------------------------------- reads

/** `GET /api/sessions/:id/terminals`: own project, or any project for an overseer key. */
export const readSessionRule: Rule = (req, ctx) =>
  ctx.scope.mayRead(must(ctx), req.params.id) ? OK : outOfScope('This thread may read its own project only.');

/** `GET /api/terminals/:terminalId` and its `conversation` and `permission` reads. */
export const readRule: Rule = (req, ctx) => {
  const target = ctx.scope.target(req.params.terminalId);
  return target && ctx.scope.mayRead(must(ctx), target.sessionId) ? OK : outOfScope('This thread may read threads in its own project only.');
};

/** `GET /api/sessions`: overseer keys only. The handler trims the answer for a key. */
export const projectListRule: Rule = (_req, ctx) =>
  must(ctx).overseer ? OK : outOfScope('Only a project overseer may list projects.');

/** `GET /api/sessions/:id/overseer/worker-defaults`: the caller's own project, overseers included. */
export const workerDefaultsRule: Rule = (req, ctx) =>
  req.params.id === must(ctx).sessionId ? OK : outOfScope('Worker defaults are for the own project only.');

// ---------------------------------------------------------------- message

const MESSAGE_FIELDS = new Set(['text', 'content', 'source']);

/** `POST /api/terminals/:terminalId/message` for a thread key. */
export const messageRule: Rule = (req, ctx) => {
  const caller = must(ctx);
  const target = ctx.scope.target(req.params.terminalId);
  if (!target || !ctx.scope.mayMessage(caller, target)) {
    return outOfScope('A thread may message threads in its own project, and an overseer may message another project\'s overseer.');
  }
  const body = bodyOf(req);
  for (const k of Object.keys(body)) if (!MESSAGE_FIELDS.has(k)) return fieldNotAllowed(k);
  if (body.source !== undefined && body.source !== 'coordinator') {
    return deny('identity_mismatch', 'A key may not send a message as the user.');
  }
  const payload = body.content !== undefined ? body.content : body.text;
  if (holdsSenderMarker(payload)) {
    return deny('identity_mismatch', 'The message holds text that looks like a sender line from another project. Remove it.');
  }
  const same = target.sessionId === caller.sessionId;
  const limit = pairs.check(caller.id, target.id, same);
  if (!limit.ok) return deny('rate_limited', limit.reason, 429);
  body.source = 'coordinator';
  req.body = body;
  if (!same && req.res) req.res.locals.fromProject = { sessionId: caller.sessionId, terminalId: caller.id };
  // A thread that is not the overseer writes to the overseer: the daemon marks the text as that thread's words (SEC-25).
  if (same && target.overseer && !caller.overseer && req.res) req.res.locals.fromThread = { terminalId: caller.id };
  return OK;
};

// ---------------------------------------------------------------- start, archive, answer, report

/** `POST /api/terminals/:terminalId/start`. */
export const directRule: Rule = (req, ctx) => {
  const target = ctx.scope.target(req.params.terminalId);
  return target && ctx.scope.mayDirect(must(ctx), target) ? OK : outOfScope('A thread may direct its own workers, and the project coordinator may direct every thread of the project.');
};

/** `DELETE /api/terminals/:terminalId` (archive): the direct rule plus the archive guard. */
export const archiveRule: Rule = (req, ctx) => {
  const direct = directRule(req, ctx);
  if (!direct.ok) return direct;
  const target = ctx.scope.target(req.params.terminalId)!;
  const allowed = checkArchiveAllowed({ role: target.role }, req.query.force === '1');
  return allowed.ok ? OK : outOfScope(allowed.reason);
};

const ANSWER_FIELDS = new Set(['decision', 'answers', 'requestId']);

/** The pending request of a thread, as the session service reads it from its manager. */
export type PendingLookup = (terminalId: string) => { requestId: string; toolName?: string; questions?: unknown[] } | null;

/** `POST /api/terminals/:terminalId/permission` (answer a question). */
export function answerRule(getPending: PendingLookup): Rule {
  return (req, ctx) => {
    const direct = directRule(req, ctx);
    if (!direct.ok) return direct;
    const body = bodyOf(req);
    for (const k of Object.keys(body)) if (!ANSWER_FIELDS.has(k)) return fieldNotAllowed(k);
    if (body.decision !== 'allow') return fieldNotAllowed('decision', 'A key may answer a question with decision "allow" only.');
    const pending = getPending(req.params.terminalId);
    if (pending) {
      if (!pending.questions?.length) return deny('not_a_question', 'The pending request is a held tool call, not a question. Only the owner may allow it.');
      if (body.requestId === undefined) return deny('identity_mismatch', 'The requestId of the pending question is required.');
      if (body.requestId !== pending.requestId) return deny('no pending permission', 'That question is gone: the requestId does not match the pending question.', 404);
    }
    if (req.res) req.res.locals.answerLogAs = 'coordinator';
    return OK;
  };
}

/** `POST /api/terminals/:terminalId/report-status`: the caller itself. */
export const selfRule: Rule = (req, ctx) =>
  req.params.terminalId === must(ctx).id ? OK : outOfScope('A thread may report its own status only.');

// ---------------------------------------------------------------- watches

/** `POST /api/watches`: the watcher is the caller (filled in or checked); the target is in the caller's project. */
export const watchCreateRule: Rule = (req, ctx) => {
  const caller = must(ctx);
  const body = bodyOf(req);
  if (body.watcherTerminalId !== undefined && body.watcherTerminalId !== caller.id) {
    return deny('identity_mismatch', 'A thread may create watches for itself only.');
  }
  if (body.targetTerminalId !== undefined) {
    const target = typeof body.targetTerminalId === 'string' ? ctx.scope.target(body.targetTerminalId) : null;
    if (!target || target.sessionId !== caller.sessionId) return outOfScope('A thread may watch threads in its own project only.');
  }
  body.watcherTerminalId = caller.id;
  req.body = body;
  return OK;
};

/** `GET /api/watches`: the `watcher` and `target` values are the caller when present, and the caller when absent. */
export const watchListRule: Rule = (req, ctx) => {
  const caller = must(ctx);
  for (const k of ['watcher', 'target'] as const) {
    const v = req.query[k];
    if (v !== undefined && v !== caller.id) return deny('identity_mismatch', `A thread may list its own watches only (${k}).`);
    req.query[k] = caller.id;
  }
  return OK;
};

/** `DELETE /api/watches/:id`: the `watcher` value is the caller; the route's ownership check then runs. */
export const watchDeleteRule: Rule = (req, ctx) => {
  const caller = must(ctx);
  const v = req.query.watcher;
  if (v !== undefined && v !== caller.id) return deny('identity_mismatch', 'A thread may remove its own watches only.');
  req.query.watcher = caller.id;
  return OK;
};

// ---------------------------------------------------------------- ledger

/**
 * The 12 ledger `POST` routes: the project is the caller's own, for an overseer key too (no
 * cross-project writes), and `caller` in the body is the key's thread. The service's own overseer
 * check then runs on the real caller.
 */
export const ledgerRule: Rule = (req, ctx) => {
  const caller = must(ctx);
  if (req.params.sessionId !== caller.sessionId) return outOfScope('The ledger of another project cannot be changed from here.');
  const body = bodyOf(req);
  if (body.caller !== undefined && body.caller !== caller.id) return deny('identity_mismatch', 'The caller must be the thread that holds the key.');
  body.caller = caller.id;
  req.body = body;
  return OK;
};

// ---------------------------------------------------------------- events, auth requests

const EVENT_PROVIDER: Record<string, string> = { 'claude-code': 'claude', codex: 'codex', grok: 'grok' };

/** `POST /api/events/:provider/:terminalId`: the caller, with the provider of its own type. */
export const eventsRule: Rule = (req, ctx) => {
  const caller = must(ctx);
  if (req.params.terminalId !== caller.id || EVENT_PROVIDER[caller.type] !== req.params.provider) {
    return outOfScope('A thread may report its own events, with its own provider.');
  }
  return OK;
};

/** `POST /api/auth-requests` for thread and shell keys: `terminalId` comes from the key. */
export const authRequestRule: Rule = (req, ctx) => {
  const caller = must(ctx);
  const body = bodyOf(req);
  if (body.terminalId !== undefined && body.terminalId !== caller.id) return deny('identity_mismatch', 'An auth request may name the calling thread only.');
  body.terminalId = caller.id;
  req.body = body;
  return OK;
};

/** `POST /api/auth-requests` for Chat keys: Chat has no thread, so `terminalId` must be absent. */
export const authRequestChatRule: Rule = (req) => {
  const body = bodyOf(req);
  if (body.terminalId !== undefined) return deny('identity_mismatch', 'A Chat key may not name a thread in an auth request.');
  return OK;
};

// ---------------------------------------------------------------- Chat keys (spec 6.4, Chat table)

/** A read that Chat and its summarizer may make in any project. */
export const allowRule: Rule = () => OK;

const chatTarget = (ctx: RuleCtx, id: unknown): CallerFacts | null => {
  const t = typeof id === 'string' && id ? ctx.scope.target(id) : null;
  return t && t.origin === 'endless' ? t : null;
};

/** `DELETE /api/terminals/:terminalId` for a Chat key: the thread was started by Chat. */
export const chatTargetRule: Rule = (req, ctx) =>
  chatTarget(ctx, req.params.terminalId) ? OK : outOfScope('Chat may act on the threads that Chat started only.');

/**
 * `GET /api/terminals/:terminalId/permission` for a Chat key: the thread was started by Chat, and the
 * handler then shows a pending QUESTION only. A held tool call (its command, its paths) stays owner-only.
 */
export const chatQuestionReadRule: Rule = (req, ctx) => {
  if (!chatTarget(ctx, req.params.terminalId)) return outOfScope('Chat may read the questions of the threads that Chat started only.');
  if (req.res) req.res.locals.questionsOnly = true;
  return OK;
};

const CHAT_ANSWER_FIELDS = new Set(['decision', 'requestId', 'reply']);

/**
 * `POST /api/terminals/:terminalId/permission` for a Chat key: a text reply to the pending question
 * of a thread that Chat started. It is the same reply the owner types in the thread's chat: a deny
 * that carries the text, pinned to the question's requestId. Chat may not pick an option, allow a
 * held tool call, use a canned action, send images, or forge a sender line.
 */
export function chatAnswerRule(getPending: PendingLookup): Rule {
  return (req, ctx) => {
    if (!chatTarget(ctx, req.params.terminalId)) return outOfScope('Chat may answer the questions of the threads that Chat started only.');
    const body = bodyOf(req);
    for (const k of Object.keys(body)) if (!CHAT_ANSWER_FIELDS.has(k)) return fieldNotAllowed(k);
    if (body.decision !== 'deny') return fieldNotAllowed('decision', 'Chat may reply to a question only (decision "deny" with a reply).');
    if (typeof body.reply !== 'string' || !body.reply.trim()) return fieldNotAllowed('reply', 'It must be a non-empty string.');
    if (typeof body.requestId !== 'string' || !body.requestId) return fieldNotAllowed('requestId', 'The requestId of the pending question is required.');
    if (holdsSenderMarker(body.reply)) {
      return deny('identity_mismatch', 'The reply holds text that looks like a sender line from another project. Remove it.');
    }
    // Only an AskUserQuestion card: another tool whose input has a `questions` array is a held tool call.
    const pending = getPending(req.params.terminalId);
    if (pending && pending.toolName !== 'AskUserQuestion') return deny('not_a_question', 'The pending request is not a question card. Only the owner may answer it.');
    if (req.res) req.res.locals.answerFromChat = true; // the daemon words it as Chat's, never as the user's
    return OK;
  };
}

/** `POST /api/endless/arm` and `/disarm`: the thread in the body was started by Chat. */
export const chatArmRule: Rule = (req, ctx) =>
  chatTarget(ctx, bodyOf(req).terminalId) ? OK : outOfScope('Chat may arm and disarm the threads that Chat started only.');

/** `POST /api/terminals/:terminalId/message` for a Chat key: a Chat thread, source coordinator, no forged sender line. */
export const chatMessageRule: Rule = (req, ctx) => {
  if (!chatTarget(ctx, req.params.terminalId)) return outOfScope('Chat may message the threads that Chat started only.');
  const body = bodyOf(req);
  for (const k of Object.keys(body)) if (!MESSAGE_FIELDS.has(k)) return fieldNotAllowed(k);
  if (body.source !== undefined && body.source !== 'coordinator') return deny('identity_mismatch', 'A key may not send a message as the user.');
  if (holdsSenderMarker(body.content !== undefined ? body.content : body.text)) {
    return deny('identity_mismatch', 'The message holds text that looks like a sender line from another project. Remove it.');
  }
  body.source = 'coordinator';
  req.body = body;
  return OK;
};
