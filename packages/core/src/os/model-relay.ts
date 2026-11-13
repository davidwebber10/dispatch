// packages/core/src/os/model-relay.ts
// The loopback model relay of a hosted box (capability `company-claude-v1`, docs/hosted.md "Company models").
//
// A Claude Code thread on a company model (os/company-model.ts) has ANTHROPIC_BASE_URL set to this
// daemon and ANTHROPIC_AUTH_TOKEN set to its own per-thread key. Its Messages traffic comes here:
//
//   thread CLI --Authorization: Bearer <thread key>--> POST /api/os-model/anthropic/v1/messages[/count_tokens]
//              --x-dispatch-box-token, x-dispatch-owner, x-dispatch-thread-id--> POST {anthropicBaseUrl}/v1/messages[...]
//
// Like the company tools route (os/tools-proxy.ts): only a thread key, only from a loopback peer, and the
// thread id comes from the key, never from the caller. The box token is added here and never reaches a
// thread. The body goes on unchanged and the answer streams back as it arrives. A request is never sent
// twice: a failure is answered, not retried. No token, key or body is ever logged.
import type { Request, Response, Router } from 'express';
import { keyRoute, policyRouter, type Rule } from '../auth/route-policy.js';
import { principalOf } from '../auth/request-principal.js';
import { isLoopbackAddress } from '../files/reveal.js';
import { boxLog } from './box-log.js';
import { MODEL_NOT_AVAILABLE, isGrantedCompanyClaude, isCompanyClaudeThread, type ModelAccess, type ModelProxy } from './company-model.js';

/** The largest body the relay forwards. */
export const MAX_RELAY_BODY_BYTES = 8 * 1024 * 1024;
/** The sentence of an unreachable platform (and of a platform 401, which Claude Code would read as a bad login). */
export const COMPANY_MODEL_UNREACHABLE = 'The company model cannot be reached. Dispatch tries again by itself.';
/** The headers taken from the caller. Everything else is dropped. */
const FORWARDED = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'] as const;
/** The headers of the platform's answer passed back to the thread. */
const RETURNED = ['content-type', 'retry-after', 'x-dispatch-refusal', 'x-should-retry'] as const;

export interface ModelRelayDeps {
  access: () => ModelAccess | null;
  proxy: () => ModelProxy | null;
  /** The box's headers to the platform (box token and owner). Never logged, never handed to a thread. */
  boxHeaders: () => Record<string, string>;
  /** The thread's type and config, null when there is no such thread or it is archived. */
  thread: (terminalId: string) => { type: string; config: Record<string, unknown> } | null;
  fetchImpl?: typeof fetch;
  /** Time limits: the whole request (default 900 s), the wait for the status line (default 120 s), between two chunks (default 90 s). */
  totalMs?: number;
  headersMs?: number;
  idleMs?: number;
}

/** The Anthropic error shape, so Claude Code shows the message. */
export function anthropicError(res: Response, status: number, message: string, type = 'api_error'): void {
  if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

const threadOnLoopback: Rule = (req) => (isLoopbackAddress(req.socket?.remoteAddress)
  ? { ok: true }
  : { ok: false, status: 403, error: 'out_of_scope', message: 'The company model route answers only on this machine.' });

/** Read the raw body up to `limit` bytes. Null when it is larger (the rest is drained, not kept). */
function readBody(req: Request, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createModelRelayRouter(deps: ModelRelayDeps): Router {
  const router = policyRouter();
  const totalMs = deps.totalMs ?? 900_000;
  const headersMs = deps.headersMs ?? 120_000;
  const idleMs = deps.idleMs ?? 90_000;

  const relay = (upstreamPath: '/v1/messages' | '/v1/messages/count_tokens') => async (req: Request, res: Response) => {
    // Only a thread key, from this machine. The owner and a caller with no credential get 403.
    let terminalId: string | null = null;
    try {
      const p = principalOf(req);
      if (p.kind === 'thread' && isLoopbackAddress(req.socket?.remoteAddress)) terminalId = p.terminalId;
    } catch { /* below */ }
    if (!terminalId) return anthropicError(res, 403, 'Only a thread on this machine calls the company model route.', 'permission_error');
    const thread = deps.thread(terminalId);
    const access = deps.access();
    const model = typeof thread?.config.model === 'string' ? thread.config.model : null;
    if (!thread || !isCompanyClaudeThread(thread.type, thread.config) || !isGrantedCompanyClaude(access, model)) {
      return anthropicError(res, 403, MODEL_NOT_AVAILABLE, 'permission_error');
    }
    let body: Buffer | null;
    try { body = await readBody(req, MAX_RELAY_BODY_BYTES); } catch { return anthropicError(res, 400, 'The request could not be read.', 'invalid_request_error'); }
    if (body === null) return anthropicError(res, 413, 'The request is larger than 8 MB.', 'request_too_large');
    // The model of the body must be the thread's company model.
    let asked: unknown;
    try { asked = JSON.parse(body.toString('utf8'))?.model; } catch { return anthropicError(res, 400, 'The request body is not JSON.', 'invalid_request_error'); }
    if (asked !== model) return anthropicError(res, 403, MODEL_NOT_AVAILABLE, 'permission_error');
    const base = deps.proxy()?.anthropicBaseUrl ?? null;
    if (!base) return anthropicError(res, 503, COMPANY_MODEL_UNREACHABLE, 'overloaded_error');

    const headers: Record<string, string> = {};
    for (const name of FORWARDED) {
      const v = req.headers[name];
      if (typeof v === 'string' && v) headers[name] = v;
    }
    // Our own: no compression, so a stream is passed on chunk by chunk.
    headers['accept-encoding'] = 'identity';
    Object.assign(headers, deps.boxHeaders(), { 'x-dispatch-thread-id': terminalId });

    const controller = new AbortController();
    let why: 'caller' | 'total' | 'headers' | 'idle' | null = null;
    const abort = (reason: typeof why) => { if (!why) why = reason; controller.abort(); };
    const total = setTimeout(() => abort('total'), totalMs);
    let idle: NodeJS.Timeout | null = setTimeout(() => abort('headers'), headersMs);
    const bump = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => abort('idle'), idleMs); };
    // The thread went away: stop the platform's work too.
    const onClose = () => { if (!res.writableFinished) abort('caller'); };
    res.on('close', onClose);
    const done = () => { clearTimeout(total); if (idle) clearTimeout(idle); idle = null; res.off('close', onClose); };
    const started = Date.now();
    try {
      const up = await (deps.fetchImpl ?? fetch)(`${base}${upstreamPath}`, { method: 'POST', headers, body: new Uint8Array(body), signal: controller.signal });
      if (up.status === 401) {
        try { await up.body?.cancel(); } catch { /* nothing to read */ }
        boxLog('model.relay', { thread: terminalId, path: upstreamPath, status: 401, sent: 503 }, 'warn');
        return anthropicError(res, 503, COMPANY_MODEL_UNREACHABLE, 'overloaded_error');
      }
      res.status(up.status);
      for (const name of RETURNED) {
        const v = up.headers.get(name);
        if (v) res.setHeader(name, v);
      }
      res.setHeader('Cache-Control', 'no-store');
      res.flushHeaders();
      bump();
      if (up.body) {
        const reader = up.body.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          bump();
          if (value?.length) {
            res.write(Buffer.from(value));
            (res as unknown as { flush?: () => void }).flush?.();
          }
        }
      }
      res.end();
      if (up.status >= 400) boxLog('model.relay', { thread: terminalId, path: upstreamPath, status: up.status }, 'warn');
    } catch (err) {
      if (why === 'caller') return void boxLog('model.relay', { thread: terminalId, path: upstreamPath, aborted: 'caller', ms: Date.now() - started });
      boxLog('model.relay', { thread: terminalId, path: upstreamPath, error: why ?? ((err as Error)?.name || 'error'), ms: Date.now() - started }, 'warn');
      anthropicError(res, 503, COMPANY_MODEL_UNREACHABLE, 'overloaded_error');
    } finally {
      done();
    }
  };

  // Every key kind reaches the handler, which refuses all but a thread key in the Anthropic error
  // shape, so Claude Code shows the sentence. A revoked or unknown key is refused before (401).
  const rules = keyRoute({ thread: threadOnLoopback, roleRun: threadOnLoopback, chat: threadOnLoopback, summarizer: threadOnLoopback, shell: threadOnLoopback, plugin: threadOnLoopback });
  router.post('/os-model/anthropic/v1/messages', rules, relay('/v1/messages'));
  router.post('/os-model/anthropic/v1/messages/count_tokens', rules, relay('/v1/messages/count_tokens'));
  return router;
}
