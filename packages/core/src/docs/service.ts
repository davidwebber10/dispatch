import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import { resolveDoc, type DocResult } from './resolve.js';

/** The doc route's view of the projects: a registered project folder, and a doc read under it only. */
export class DocsService {
  constructor(private readonly db: Database.Database) {}
  project(id: string): { id: string; folder: string } | null {
    const s = sessionsDb.getById(this.db, id);
    return s ? { id: s.id, folder: s.working_dir } : null;
  }
  /** Null for an unknown project. */
  doc(projectId: string, docPath: string, branch: string | null): DocResult | null {
    const p = this.project(projectId);
    return p ? resolveDoc(p, docPath, { branch }) : null;
  }
}
