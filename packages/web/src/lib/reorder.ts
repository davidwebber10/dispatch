/** Pure list reorder: move `activeId` to where `overId` sits. No-op on self/null/unknown. */
export function reorderIds(ids: string[], activeId: string, overId: string | null): string[] {
  if (!overId || activeId === overId) return ids;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1) return ids;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}
