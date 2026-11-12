// packages/core/src/privsep/boot.ts
// What the daemon does at start on a box with privilege separation, before it opens its database
// (prepare) and before it listens (prove). See docs/hosted-privilege-separation.md.
import fs from 'node:fs';
import path from 'node:path';
import type { PrivsepConfig } from './config.js';
import { migrateLegacyHome, type MigrationResult } from './migrate.js';
import { giveToAgent } from './paths.js';
import { probeSpawnGuard } from './spawn-guard.js';
import { runSelfCheck, setSelfCheckVerdict, type SelfCheckResult } from './selfcheck.js';

export interface PrepareResult { migration: MigrationResult }

/**
 * Check and prepare the three roots, then move an older box's state out of the home. Throws when
 * the state root could be reached by another user: the daemon must not start on an unsafe layout.
 */
export function prepareSeparatedBox(cfg: PrivsepConfig, env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (l) => console.log(l)): PrepareResult {
  // The parent of the state root is the lock: on a mount that enforces one user for every client,
  // mode bits inside the mount mean nothing, so it must be a local folder only root can enter.
  const gate = path.dirname(cfg.stateDir);
  const g = fs.lstatSync(gate);
  if (!g.isDirectory() || g.uid !== 0 || (g.mode & 0o077) !== 0) {
    throw new Error(`privilege separation: ${gate} must be a folder owned by root with mode 0700 (found uid ${g.uid}, mode ${(g.mode & 0o777).toString(8)}).`);
  }
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(cfg.stateDir, 0o700); } catch { /* an enforced mount may refuse; the parent is the lock */ }

  // The agent run dir starts empty at each start: nothing a workload left there is trusted.
  fs.mkdirSync(cfg.agentRunDir, { recursive: true, mode: 0o755 });
  for (const n of fs.readdirSync(cfg.agentRunDir)) fs.rmSync(path.join(cfg.agentRunDir, n), { recursive: true, force: true });
  fs.chownSync(cfg.agentRunDir, 0, 0);
  fs.chmodSync(cfg.agentRunDir, 0o755);

  // The home and the agent data dir belong to the agent.
  fs.mkdirSync(cfg.agentHome, { recursive: true });
  giveToAgent(cfg.agentHome, cfg);
  const legacy = fs.existsSync(cfg.agentDataDir) ? fs.lstatSync(cfg.agentDataDir) : null;
  if (legacy && !legacy.isDirectory()) fs.rmSync(cfg.agentDataDir, { force: true }); // a link or a file here is not ours
  const migration = migrateLegacyHome({
    legacyDir: cfg.agentDataDir, stateDir: cfg.stateDir,
    allowImport: env.DISPATCH_MIGRATE_LEGACY_HOME === '1', log,
  });
  fs.mkdirSync(cfg.agentDataDir, { recursive: true, mode: 0o700 });
  giveToAgent(cfg.agentDataDir, cfg);
  return { migration };
}

export interface ProofResult { guardOk: boolean; guard: Array<{ via: string; uid: string }>; selfCheck: SelfCheckResult }

/**
 * Prove the separation for this start. A spawn entry point that does not give the agent uid is
 * fatal (the caller exits). A failed self-check is not fatal: the box runs, does not report
 * `privsep-v1`, and the platform refuses what needs it.
 */
export async function proveSeparatedBox(cfg: PrivsepConfig): Promise<ProofResult> {
  const guard = await probeSpawnGuard();
  const guardOk = guard.every((g) => g.uid === String(cfg.agentUid));
  const selfCheck = guardOk ? await runSelfCheck(cfg) : { ok: false, failures: ['the spawn guard is not in effect'], lines: [] };
  setSelfCheckVerdict(selfCheck);
  return { guardOk, guard, selfCheck };
}
