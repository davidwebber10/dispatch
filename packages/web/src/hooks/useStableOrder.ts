import { useEffect, useReducer, useRef } from 'react';

export type ProjectSort = 'recent' | 'alpha' | 'custom';
type Orderable = { id: string; name: string; lastActivityAt?: string; updatedAt?: string };

const activityAt = (x: Orderable) => Date.parse(x.lastActivityAt || x.updatedAt || '') || 0;
const byRecent = (a: Orderable, b: Orderable) => activityAt(b) - activityAt(a);

/**
 * Orders a project list without letting it jitter. Every status event bumps a session's
 * lastActivityAt, so re-sorting "Most recent" on each render made two busy projects swap
 * places over and over. For 'recent' this keeps a frozen order of ids and re-sorts only on:
 * first mount, a sort-mode change, the tab becoming visible again, or the id set changing
 * (added ids go to the top, existing ids keep their order, removed ids drop out).
 * 'alpha' is stable by itself so it sorts each render; 'custom' keeps the server's order.
 * Item objects are always the current ones, so card content stays live.
 */
export function useStableOrder<T extends Orderable>(items: T[], sort: ProjectSort): T[] {
  const [epoch, bump] = useReducer((n: number) => n + 1, 0);
  const frozen = useRef<{ ids: string[]; sort: ProjectSort; epoch: number } | null>(null);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') bump(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (sort !== 'recent') {
    frozen.current = null; // leaving 'recent' forgets the frozen order, so coming back re-sorts
    return sort === 'alpha' ? items.slice().sort((a, b) => a.name.localeCompare(b.name)) : items.slice();
  }

  const prev = frozen.current;
  let ids: string[];
  if (!prev || prev.sort !== sort || prev.epoch !== epoch) {
    ids = items.slice().sort(byRecent).map((x) => x.id);
  } else {
    const live = new Set(items.map((x) => x.id));
    const known = new Set(prev.ids);
    const added = items.filter((x) => !known.has(x.id)).sort(byRecent).map((x) => x.id);
    ids = [...added, ...prev.ids.filter((id) => live.has(id))];
  }
  frozen.current = { ids, sort, epoch };

  const byId = new Map(items.map((x) => [x.id, x]));
  return ids.map((id) => byId.get(id)!);
}
