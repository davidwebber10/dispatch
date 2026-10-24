import fs from 'node:fs';
import path from 'node:path';
import type { KeyHandle, KeyRegistry } from '../auth/principals.js';

/**
 * Key lifecycle per process (per-thread keys, stage 1, spec 6.2 and 6.5).
 *
 * The service mints a key right before a process starts, binds it to that process once the spawn
 * returns, and revokes it by handle when that process exits, stops, is archived or deleted, or
 * never starts. Revoking by handle (never "whatever is live for this terminal") is what keeps a
 * late exit of an old process from killing the key of its replacement.
 *
 * Two extras, both decided by the delivery probes:
 *  - the Codex Pretty sticky key: a resume in a running turn keeps the OLD MCP set, so a Codex
 *    Pretty thread keeps one key for its whole life on this daemon (revoked on archive, delete,
 *    a switch to the CLI view and the daemon's own stop; NOT on exit or an owner stop);
 *  - key files: the Codex CLI view writes its environment to a snapshot file, so its key goes in
 *    a per-handle file of mode 0600 and only the path travels in the environment.
 */
export class ThreadKeys {
  private readonly keyDir: string | undefined;
  private readonly codexSticky: boolean;
  /** terminal -> pid -> handle, for PTY processes. */
  private pty = new Map<string, Map<number, KeyHandle>>();
  /** terminal -> handle of the structured session that is running now. */
  private structured = new Map<string, KeyHandle>();
  /** terminal -> the sticky Codex Pretty key. */
  private sticky = new Map<string, { key: string; handle: KeyHandle }>();
  /** handle -> key file path, deleted when the handle is revoked. */
  private files = new Map<KeyHandle, string>();

  constructor(private readonly registry: KeyRegistry, opts: { keyDir?: string; codexSticky?: boolean } = {}) {
    this.keyDir = opts.keyDir;
    this.codexSticky = opts.codexSticky ?? true;
  }

  /** A new key for a process that is about to start. The terminal's previous key is revoked. */
  mintForSpawn(terminalId: string, kind: 'thread' | 'shell'): { key: string; handle: KeyHandle } {
    const old = this.registry.liveHandleFor(terminalId);
    if (old) this.revokeHandle(old);
    this.sticky.delete(terminalId); // a non-Pretty spawn (the CLI view) ends the sticky key
    return this.registry.mint({ kind, terminalId });
  }

  /** Call after ptyManager.spawn returns, with the pid it returned. */
  bindPty(terminalId: string, pid: number, handle: KeyHandle): void {
    let m = this.pty.get(terminalId);
    if (!m) this.pty.set(terminalId, (m = new Map()));
    m.set(pid, handle);
  }

  /** Revokes only the handle bound to that pid. A relaunch whose old PTY exits late keeps the new key. */
  onPtyExit(terminalId: string, pid: number): void {
    const m = this.pty.get(terminalId);
    const handle = m?.get(pid);
    if (!m || handle === undefined) return;
    m.delete(pid);
    if (m.size === 0) this.pty.delete(terminalId);
    if (!this.isSticky(handle)) this.revokeHandle(handle);
  }

  /** Call after manager.spawn returns. */
  bindStructured(terminalId: string, handle: KeyHandle): void {
    this.structured.set(terminalId, handle);
  }

  /** Revokes the handle bound at this moment, then unbinds. The sticky key survives. */
  onStructuredExit(terminalId: string): void {
    const handle = this.structured.get(terminalId);
    if (handle === undefined) return;
    this.structured.delete(terminalId);
    if (!this.isSticky(handle)) this.revokeHandle(handle);
  }

  /** The spawn threw or gave no pid. A key that is already bound to a process, or sticky, stays. */
  spawnFailed(handle: KeyHandle): void {
    if (this.isSticky(handle) || this.isBound(handle)) return;
    this.revokeHandle(handle);
  }

  /** Stop, stop-all: the terminal's current key, except the sticky Codex Pretty key. */
  revokeLive(terminalId: string): void {
    const live = this.registry.liveHandleFor(terminalId);
    if (live && !this.isSticky(live)) this.revokeHandle(live);
  }

  /** Stop-all: the PTY keys only, because stop-all kills PTYs only. Pretty (structured) keys stay. */
  revokeAllLive(): void {
    const handles = new Set<KeyHandle>();
    for (const m of this.pty.values()) for (const h of m.values()) handles.add(h);
    for (const h of handles) if (!this.isSticky(h)) this.revokeHandle(h);
  }

  /** Archive, delete, a switch to the CLI view: the sticky Codex Pretty key of this terminal. */
  revokeSticky(terminalId: string): void {
    const s = this.sticky.get(terminalId);
    if (!s) return;
    this.sticky.delete(terminalId);
    this.revokeHandle(s.handle);
  }

  /** The daemon's own stop: every key this object tracks, the sticky ones included. */
  revokeAll(): void {
    const handles = new Set<KeyHandle>();
    for (const m of this.pty.values()) for (const h of m.values()) handles.add(h);
    for (const h of this.structured.values()) handles.add(h);
    for (const s of this.sticky.values()) handles.add(s.handle);
    for (const h of this.files.keys()) handles.add(h);
    this.pty.clear();
    this.structured.clear();
    this.sticky.clear();
    for (const h of handles) this.revokeHandle(h);
  }

  /**
   * Codex Pretty: one key per terminal for its whole life, returned again at every later Codex
   * Pretty spawn (resume, relaunch, restart, owner stop and revive, crash recovery). With the
   * sticky branch off, it is a normal mint.
   */
  codexKey(terminalId: string): { key: string; handle: KeyHandle } {
    if (!this.codexSticky) return this.mintForSpawn(terminalId, 'thread');
    const s = this.sticky.get(terminalId);
    if (s && this.registry.liveHandleFor(terminalId) === s.handle) return s;
    const minted = this.mintForSpawn(terminalId, 'thread'); // also clears a stale sticky entry
    this.sticky.set(terminalId, minted);
    return minted;
  }

  /**
   * Write the key to DATA/keys/ID.H (H: the first 12 characters of the handle), mode 0600, in a
   * 0700 folder. The file is created with O_EXCL, so a file or a symlink that already sits at the
   * path makes this throw instead of being followed or overwritten. Deleted when the handle is
   * revoked. Returns the path (not secret).
   */
  writeKeyFile(terminalId: string, key: string, handle: KeyHandle): string {
    if (!this.keyDir) throw new Error('no key directory is set');
    if (!/^[A-Za-z0-9_-]+$/.test(terminalId)) throw new Error('refusing a terminal id that is not a plain name');
    fs.mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.keyDir, `${terminalId}.${handle.slice(0, 12)}`);
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeSync(fd, `${key}\n`);
    } finally {
      fs.closeSync(fd);
    }
    this.files.set(handle, file);
    return file;
  }

  private isSticky(handle: KeyHandle): boolean {
    for (const s of this.sticky.values()) if (s.handle === handle) return true;
    return false;
  }

  private isBound(handle: KeyHandle): boolean {
    for (const h of this.structured.values()) if (h === handle) return true;
    for (const m of this.pty.values()) for (const h of m.values()) if (h === handle) return true;
    return false;
  }

  private revokeHandle(handle: KeyHandle): void {
    this.registry.revoke(handle);
    const file = this.files.get(handle);
    if (!file) return;
    this.files.delete(handle);
    try {
      // lstat, not stat: a symlink at the path is never followed and never removed.
      const st = fs.lstatSync(file);
      if (st.isFile()) fs.unlinkSync(file);
    } catch { /* already gone */ }
  }
}
