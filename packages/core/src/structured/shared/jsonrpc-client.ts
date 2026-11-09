// packages/core/src/structured/shared/jsonrpc-client.ts
//
// One newline-delimited JSON-RPC 2.0 channel to a child process over its stdio. It replaces the
// two connection classes that the Codex manager (`codex app-server`) and the ACP manager
// (`grok agent stdio`, `opencode acp`) each had. It matches requests to their answers, and gives
// the server's own requests and notifications to its owner. It knows nothing about the payloads.
//
// Events:
//   'notification' (method, params)   a message with a method and no id
//   'request'      (method, id, params) a server request: the owner must `respond` or `respondError`
//   'exit'         (code)             the child ended; every pending request was rejected first
//   'stderr'       (text)             a chunk of the child's stderr (read so the pipe never fills)
//   'spawn-error'  (err)              the child could not start

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import { killWithGrace } from '../../platform/kill-grace.js';

/** A JSON-RPC message id. Our requests use a counter; the server's requests use its own ids. */
export type RpcId = string | number;

/** The part of a child process that the client uses. A test passes a fake. */
export interface JsonRpcChild {
  stdin: NodeJS.WritableStream & { writable?: boolean };
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface JsonRpcClientOptions {
  /** The error for an answer that carries `error` (a refusal). Default: a plain Error. */
  rpcError?: (message: string) => Error;
  /** The wording of the transport failures. Each harness keeps its own. */
  messages?: {
    /** A pending request when the child ends. */
    exited?: string;
    /** A request after the child ended or the client closed. */
    notConnected?: string;
    /** A request with a timeout that got no answer. */
    timeout?: (method: string) => string;
  };
}

export interface JsonRpcClientEvents {
  notification: [method: string, params: any]; // eslint-disable-line @typescript-eslint/no-explicit-any -- a protocol payload
  request: [method: string, id: RpcId, params: any]; // eslint-disable-line @typescript-eslint/no-explicit-any -- a protocol payload
  exit: [code: number];
  stderr: [text: string];
  'spawn-error': [err: unknown];
}

interface Pending {
  resolve: (value: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any -- the caller names the type
  reject: (err: unknown) => void;
}

export class JsonRpcStdioClient extends EventEmitter<JsonRpcClientEvents> {
  private readonly rl: readline.Interface;
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private closed = false;
  private skipped = 0;
  private readyPromise: Promise<void> = Promise.resolve();
  private readonly rpcError: (message: string) => Error;
  private readonly exitedMessage: string;
  private readonly notConnectedMessage: string;
  private readonly timeoutMessage: (method: string) => string;

  constructor(readonly child: JsonRpcChild, opts: JsonRpcClientOptions = {}) {
    super();
    this.setMaxListeners(0);
    this.rpcError = opts.rpcError ?? ((message) => new Error(message));
    this.exitedMessage = opts.messages?.exited ?? 'the process exited';
    this.notConnectedMessage = opts.messages?.notConnected ?? 'the process is not connected';
    this.timeoutMessage = opts.messages?.timeout ?? ((method) => `${method} timed out`);
    child.stdin.on('error', () => {}); // suppress EPIPE if the child closes stdin while alive
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));
    child.stderr?.on('data', (chunk: Buffer | string) => { this.emit('stderr', chunk.toString()); });
    child.on('exit', (code) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error(this.exitedMessage));
      this.pending.clear();
      this.emit('exit', code ?? 0);
    });
    child.on('error', (err) => { this.emit('spawn-error', err); });
  }

  /** Start `command` and open a client on its stdio. */
  static spawn(command: string, args: string[], spawnOpts: { cwd: string; env: Record<string, string> }, opts: JsonRpcClientOptions = {}): JsonRpcStdioClient {
    const child = spawn(command, args, { cwd: spawnOpts.cwd, env: spawnOpts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    return new JsonRpcStdioClient(child as JsonRpcChild, opts);
  }

  get pid(): number { return this.child.pid ?? -1; }
  get alive(): boolean { return !this.closed; }
  /** How many stdout lines were not JSON. They are skipped, never thrown. */
  get skippedLines(): number { return this.skipped; }
  /** Settles with the handshake that `start` ran. Resolved already when there is none. */
  get ready(): Promise<void> { return this.readyPromise; }

  /** Run the protocol's handshake (its `initialize`). `ready` then settles with it. */
  start(handshake: (client: JsonRpcStdioClient) => Promise<void>): void {
    this.readyPromise = handshake(this);
    this.readyPromise.catch(() => { /* the owner awaits `ready` and sees the failure there */ });
  }

  private onLine(line: string): void {
    const s = line.trim();
    if (!s) return;
    let msg: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- an untyped wire message
    try { msg = JSON.parse(s); } catch { this.skipped += 1; return; }
    if (!msg || typeof msg !== 'object') { this.skipped += 1; return; }
    // An answer to one of OUR requests: an id and a result or an error, no method.
    if (msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(this.rpcError(msg.error?.message || 'rpc error'));
      else p.resolve(msg.result);
      return;
    }
    // A server request: an id and a method. It must be answered.
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.emit('request', msg.method, msg.id, msg.params ?? {});
      return;
    }
    // A notification: a method only.
    if (typeof msg.method === 'string') this.emit('notification', msg.method, msg.params ?? {});
  }

  /**
   * Send a request. With `timeoutMs` the promise rejects AND the pending entry is dropped, so a
   * request that is never answered cannot pile up on a long-lived connection.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the default for callers that read an untyped payload
  request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.notConnectedMessage));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (timeoutMs !== undefined) {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(this.timeoutMessage(method))); }, timeoutMs);
        timer.unref?.();
        this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      } else {
        this.pending.set(id, { resolve, reject });
      }
      this.writeRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.writeRaw({ jsonrpc: '2.0', method, params });
  }

  /** Answer a server request, with its id. */
  respond(id: RpcId, result: unknown): void {
    if (this.closed) return;
    this.writeRaw({ jsonrpc: '2.0', id, result });
  }

  /** Refuse a server request, so that it does not stay open on the server. */
  respondError(id: RpcId, code: number, message: string): void {
    if (this.closed) return;
    this.writeRaw({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private writeRaw(obj: unknown): void {
    if (this.closed || this.child.stdin.writable === false) return;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** Stop the child: SIGTERM, then SIGKILL if it ignores that. */
  close(): void {
    this.closed = true;
    try { this.rl.close(); } catch { /* noop */ }
    killWithGrace(this.child as unknown as ChildProcess);
  }
}

/** JSON-RPC "method not found": the code for a server request that the owner does not handle. */
export const METHOD_NOT_FOUND = -32601;
