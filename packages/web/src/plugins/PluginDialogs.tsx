import { create } from 'zustand';
import { EditAgentModal } from '../components/agents/EditAgentModal';
import { NewThreadModal } from '../components/sidebar/NewThreadModal';
import { useAgentUI } from '../stores/agentUI';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';
import { CreateSkillSheet, type SkillDraftIn } from './CreateSkillSheet';

/** The desktop default: the project open, the thread's tab focused. */
const openTab = (sessionId: string, terminalId: string): void => {
  useProjects.getState().setActive(sessionId);
  useAgentUI.getState().blur();
  useTabs.getState().setActiveTab(terminalId);
};

/**
 * The dialogs a plugin may open pre-filled (coach spec section 4.1, 9a.5): the schedule dialog
 * ("Run every Monday") and the new-thread dialog ("Split into 3 threads"). Nothing is created
 * until the person confirms in the dialog; Cancel creates nothing.
 */
export interface SchedulePrefill { sessionId: string; prompt: string; cron?: string; label?: string }
export interface NewThreadsPrefill { sessionId: string; prompts: string[] }

interface PluginDialogsState {
  schedule: SchedulePrefill | null;
  newThreads: NewThreadsPrefill | null;
  /** The skill review sheet (coach spec section 4.8) and the promise it settles. */
  skill: { draft: SkillDraftIn; resolve: (r: { id: string } | null) => void } | null;
  openSkill: (draft: SkillDraftIn) => Promise<{ id: string } | null>;
  doneSkill: (r: { id: string } | null) => void;
  openSchedule: (p: { projectId?: string; prompt: string; cron?: string; label?: string }) => void;
  openNewThreads: (p: { projectId?: string; prompts: string[] }) => void;
  close: () => void;
}

/** The named project, else the open one, else the first. */
function projectOf(projectId: string | undefined): string | null {
  const { sessions, activeId } = useProjects.getState();
  if (projectId && sessions.some((s) => s.id === projectId)) return projectId;
  return activeId ?? sessions[0]?.id ?? null;
}

export const usePluginDialogs = create<PluginDialogsState>((set, get) => ({
  schedule: null,
  newThreads: null,
  skill: null,
  openSkill: (draft) => {
    if (!draft || typeof draft.name !== 'string' || typeof draft.body !== 'string') return Promise.resolve(null);
    get().skill?.resolve(null); // a sheet already open is cancelled
    return new Promise((resolve) => set({ skill: { draft, resolve } }));
  },
  doneSkill: (r) => { const s = get().skill; set({ skill: null }); s?.resolve(r); },
  openSchedule: ({ projectId, prompt, cron, label }) => {
    const sessionId = projectOf(projectId);
    if (!sessionId || typeof prompt !== 'string') return;
    set({ newThreads: null, schedule: { sessionId, prompt, ...(typeof cron === 'string' && cron.trim() ? { cron: cron.trim() } : {}), ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}) } });
  },
  openNewThreads: ({ projectId, prompts }) => {
    const sessionId = projectOf(projectId);
    const list = (Array.isArray(prompts) ? prompts : []).filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim());
    if (!sessionId || list.length === 0) return;
    set({ schedule: null, newThreads: { sessionId, prompts: list } });
  },
  close: () => set({ schedule: null, newThreads: null }),
}));

/** Mounted once beside the app's other modals (desktop and phone). */
export function PluginDialogs({ onAgentSaved, onThreadCreated }: {
  /** Where a saved automation opens (the phone has its own navigation). Default: select it. */
  onAgentSaved?: (id: string) => void;
  /** Where the first new thread opens. Default: focus its tab. */
  onThreadCreated?: (sessionId: string, terminalId: string) => void;
} = {}) {
  const schedule = usePluginDialogs((s) => s.schedule);
  const newThreads = usePluginDialogs((s) => s.newThreads);
  const close = usePluginDialogs((s) => s.close);
  const skill = usePluginDialogs((s) => s.skill);
  const doneSkill = usePluginDialogs((s) => s.doneSkill);
  return (
    <>
      {skill && <CreateSkillSheet key={`skill:${skill.draft.name}`} draft={skill.draft} onDone={doneSkill} />}
      {schedule && (
        <EditAgentModal
          key={`schedule:${schedule.sessionId}:${schedule.prompt}`}
          scheduleId={null}
          presetProjectId={schedule.sessionId}
          prefill={{ prompt: schedule.prompt, cron: schedule.cron, name: schedule.label }}
          onClose={close}
          onSaved={(id) => (onAgentSaved ?? ((x: string) => useAgentUI.getState().selectAgent(x)))(id)}
        />
      )}
      {newThreads && (
        <NewThreadModal
          key={`threads:${newThreads.sessionId}:${newThreads.prompts.join('\u0000')}`}
          sessionId={newThreads.sessionId}
          prompts={newThreads.prompts}
          onClose={close}
          onCreated={(id) => (onThreadCreated ?? openTab)(newThreads.sessionId, id)}
        />
      )}
    </>
  );
}
