// packages/core/src/files/path-policy-default.ts
// The path policy of THIS daemon (files/path-policy.ts): hosted or not, the live profile, the home and
// data folders, the app folder of a hosted image, and the folders of the live projects.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import { isHostedBox } from '../os/hosted-mode.js';
import { currentProfile } from '../os/profile.js';
import { platform } from '../platform/index.js';
import { expandHome } from '../sessions/project-dir.js';
import { PathPolicy } from './path-policy.js';
import { privsep } from '../privsep/config.js';

/** The folder the daemon's code runs from (the same from src/ and from dist/: both sit at the same depth). */
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function pathPolicyFor(db: Database.Database): PathPolicy {
  return daemonPathPolicy(() => {
    try { return sessionsDb.list(db).map((s) => expandHome(s.working_dir)); } catch { return []; }
  });
}

/** The same, for a caller that lists the project folders its own way. */
export function daemonPathPolicy(projectDirs: () => string[]): PathPolicy {
  return new PathPolicy(() => {
    const hosted = isHostedBox();
    return {
      hosted,
      profile: currentProfile(),
      home: os.homedir(),
      dataDir: platform.dataDir(),
      // Privilege separation: the state is outside the home, and `~/.dispatch` keeps the harness
      // account folders. It was refused as the data folder before; it stays refused.
      agentDataDir: privsep()?.agentDataDir ?? null,
      // On a hosted box the code is the image's (`/app`), never a folder the person works in. A local
      // developer may well have the Dispatch repository open as a project: nothing is refused there.
      appDir: hosted ? APP_DIR : null,
      projectDirs,
    };
  });
}
