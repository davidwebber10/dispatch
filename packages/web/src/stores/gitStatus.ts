import { create } from 'zustand';
import { api } from '../api/client';

/**
 * Working-tree git state per project, for the Files pane and the Inspector's
 * Files-tab badge. Fetched on demand (Inspector mount, project switch, manual
 * refresh) — deliberately no polling; a stale count corrects on the next refresh.
 */
export interface ProjectGitStatus {
  branch: string | null;
  /** workingDir-relative path → one status letter (M/A/D/R/?) */
  changed: Record<string, string>;
  count: number;
}

const EMPTY: ProjectGitStatus = { branch: null, changed: {}, count: 0 };

export const useGitStatus = create<{
  byProject: Record<string, ProjectGitStatus>;
  refresh: (projectId: string) => Promise<void>;
}>((set) => ({
  byProject: {},
  refresh: async (projectId) => {
    try {
      const s = await api.getGitStatus(projectId);
      const changed: Record<string, string> = {};
      for (const f of s.files) changed[f.path] = f.status;
      set((prev) => ({
        byProject: { ...prev.byProject, [projectId]: { branch: s.branch, changed, count: s.files.length } },
      }));
    } catch {
      set((prev) => ({ byProject: { ...prev.byProject, [projectId]: EMPTY } }));
    }
  },
}));

export const gitStatusFor = (byProject: Record<string, ProjectGitStatus>, projectId: string | null): ProjectGitStatus =>
  (projectId && byProject[projectId]) || EMPTY;
