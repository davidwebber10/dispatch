import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';

/** A random id made once per install. It is not derived from the machine, the user, or any account. */
export function getInstallId(db: Database.Database): string {
  const have = appState.get(db, 'telemetry_install_id');
  if (have) return have;
  const id = randomUUID();
  appState.set(db, 'telemetry_install_id', id);
  return id;
}
