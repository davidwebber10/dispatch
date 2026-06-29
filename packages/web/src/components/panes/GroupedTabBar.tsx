/**
 * GroupedTabBar — drop-in operator tab strip with multi-pane grouping.
 *
 * Operator mode only, gated by the `multiPane` setting.  Falls back to
 * classic TabBar behaviour when either condition is false.
 *
 * Features added on top of the classic bar:
 *  - Drag-to-reorder via @dnd-kit (horizontal sort)
 *  - Drag a single tab onto another tab/group → merge affordance on the
 *    target chip + on-drop calls useGroups.merge / addToGroup
 *  - Group chips: stack icon + member count, unmerge (ArrowsOut) + X close-all
 *  - Selecting a group chip activates the first tab in the group
 *    (App.tsx detects the active tab is grouped and renders PaneTree)
 *
 * Do NOT import this file in more than one place at a time; it is a
 * self-contained drop-in.  Wire it into App.tsx in place of <TabBar/>.
 */

import { useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SquaresFour, ArrowsOut } from '@phosphor-icons/react';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useSettings } from '../../stores/settings';
import { useViewMode } from '../../stores/viewMode';
import { useGroups } from './store';
import { leafTabIds, leafCount, MAX_PANES } from './types';
import { reorderIds } from '../../lib/reorder';

/* ── Constants ───────────────────────────────────────────────────────── */
const BAR_H      = 44;
const TAB_MIN_W  = 150;
const TAB_MAX_W  = 230;
const GRP_MIN_W  = 185;
const GRP_MAX_W  = 290;

/* ── Slot model ──────────────────────────────────────────────────────── */
type SingleSlot = { kind: 'single'; id: string; tabId: string };
type GroupSlot  = { kind: 'group';  id: string; groupId: string; tabIds: string[] };
type TabSlot    = SingleSlot | GroupSlot;

/* ── Shared button style ─────────────────────────────────────────────── */
const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none',
  color: 'var(--color-text-tertiary)', cursor: 'pointer',
  padding: '2px 4px', borderRadius: 4,
  flexShrink: 0, display: 'flex', alignItems: 'center',
  position: 'relative', zIndex: 2,
  fontSize: 15, lineHeight: 1,
};

/* ── Persist helper (mirrors useTabs internal persist) ───────────────── */
function persistTabs() {
  const s = useTabs.getState();
  try {
    localStorage.setItem('dispatch:tabs', JSON.stringify({
      openTabIds: s.openTabIds,
      activeTabId: s.activeTabId,
      tabSession:  s.tabSession,
    }));
  } catch { /* ignore */ }
}

/* ═══════════════════════════════════════════════════════════════════════
   Classic TabBar fallback  (identical to components/layout/TabBar.tsx)
   Rendered when multiPane is off or mode !== 'operator'.
   ═══════════════════════════════════════════════════════════════════════ */
function ClassicTabBar({ onSelect }: { onSelect?: () => void }) {
  const openTabIds  = useTabs((s) => s.openTabIds);
  const activeTabId = useTabs((s) => s.activeTabId);
  const byProject   = useTabs((s) => s.byProject);
  const sessions    = useProjects((s) => s.sessions);

  if (!openTabIds.length) return null;

  return (
    <div style={{
      display: 'flex', height: BAR_H, flexShrink: 0,
      overflowX: 'auto',
      background: 'var(--color-pane)',
      borderBottom: '1px solid var(--color-border)',
    }}>
      {openTabIds.map((id) => {
        const t    = findTerminal(byProject, id);
        const proj = sessions.find((s) => s.id === t?.sessionId);
        const act  = id === activeTabId;
        return (
          <div
            key={id}
            onClick={() => { onSelect?.(); useTabs.getState().setActiveTab(id); }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); useTabs.getState().closeTab(id); } }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '0 10px 0 15px',
              minWidth: TAB_MIN_W, maxWidth: TAB_MAX_W, flexShrink: 0,
              cursor: 'pointer',
              borderRight: '1px solid var(--color-border)',
              background:    act ? 'var(--color-base)' : 'transparent',
              borderBottom:  act ? '2px solid var(--color-accent)' : '2px solid transparent',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.2 }}>
              <span style={{ fontSize: 12.5, fontWeight: act ? 500 : 400, color: act ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t?.label ?? 'tab'}
              </span>
              <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {proj?.name ?? ''}
              </span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); useTabs.getState().closeTab(id); }}
              title="Close tab"
              style={iconBtn}
            >×</button>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Merge affordance overlay  (shown on the target chip while dragging)
   ═══════════════════════════════════════════════════════════════════════ */
function MergeOverlay({ label }: { label: string }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3,
      border: '2px solid var(--color-accent)',
      background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--color-accent)', borderRadius: 4,
        padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <SquaresFour size={11} weight="bold" color="#000" />
        <span style={{ fontSize: 10, color: '#000', fontWeight: 700 }}>{label}</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Single-tab sortable chip
   ═══════════════════════════════════════════════════════════════════════ */
function SortableSingleChip({
  slot, onSelect, isMergeTarget,
}: { slot: SingleSlot; onSelect?: () => void; isMergeTarget: boolean }) {
  const activeTabId = useTabs((s) => s.activeTabId);
  const byProject   = useTabs((s) => s.byProject);
  const sessions    = useProjects((s) => s.sessions);

  const t    = findTerminal(byProject, slot.tabId);
  const proj = sessions.find((s) => s.id === t?.sessionId);
  const act  = slot.tabId === activeTabId;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: slot.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(transform),
        transition,
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 10px 0 15px',
        minWidth: TAB_MIN_W, maxWidth: TAB_MAX_W, flexShrink: 0,
        height: '100%',
        cursor: isDragging ? 'grabbing' : 'pointer',
        borderRight: '1px solid var(--color-border)',
        background:   act ? 'var(--color-base)' : 'transparent',
        borderBottom: act ? '2px solid var(--color-accent)' : '2px solid transparent',
        opacity: isDragging ? 0 : 1,
        userSelect: 'none',
        touchAction: 'none',
      }}
      {...attributes}
      {...listeners}
      onClick={() => { onSelect?.(); useTabs.getState().setActiveTab(slot.tabId); }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); useTabs.getState().closeTab(slot.tabId); } }}
    >
      {isMergeTarget && <MergeOverlay label="Merge" />}

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.2 }}>
        <span style={{ fontSize: 12.5, fontWeight: act ? 500 : 400, color: act ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t?.label ?? 'tab'}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {proj?.name ?? ''}
        </span>
      </div>

      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); useTabs.getState().closeTab(slot.tabId); }}
        title="Close tab"
        style={iconBtn}
      >×</button>
    </div>
  );
}

/* Drag-overlay ghost for a single tab (no hooks that depend on slot changes) */
function SingleTabGhost({ slot }: { slot: SingleSlot }) {
  const byProject = useTabs((s) => s.byProject);
  const sessions  = useProjects((s) => s.sessions);
  const t    = findTerminal(byProject, slot.tabId);
  const proj = sessions.find((s) => s.id === t?.sessionId);

  return (
    <div style={{
      height: BAR_H, display: 'flex', alignItems: 'center', gap: 10,
      padding: '0 10px 0 15px',
      minWidth: TAB_MIN_W, maxWidth: TAB_MAX_W,
      background: 'var(--color-pane)',
      borderRight: '1px solid var(--color-border)',
      borderBottom: '2px solid var(--color-accent)',
      opacity: 0.92,
      boxShadow: '0 8px 28px rgba(0,0,0,.5)',
      cursor: 'grabbing',
      userSelect: 'none',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.2 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t?.label ?? 'tab'}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {proj?.name ?? ''}
        </span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Group-chip sortable chip
   ═══════════════════════════════════════════════════════════════════════ */
function SortableGroupChip({
  slot, onSelect, isMergeTarget,
}: { slot: GroupSlot; onSelect?: () => void; isMergeTarget: boolean }) {
  const activeTabId = useTabs((s) => s.activeTabId);
  const byProject   = useTabs((s) => s.byProject);

  const act        = slot.tabIds.includes(activeTabId ?? '');
  const count      = slot.tabIds.length;
  const firstLabel = findTerminal(byProject, slot.tabIds[0])?.label ?? 'tab';

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: slot.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(transform),
        transition,
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '0 8px 0 12px',
        minWidth: GRP_MIN_W, maxWidth: GRP_MAX_W, flexShrink: 0,
        height: '100%',
        cursor: isDragging ? 'grabbing' : 'pointer',
        borderRight: '1px solid var(--color-border)',
        background:   act ? 'var(--color-base)' : 'transparent',
        borderBottom: act ? '2px solid var(--color-accent)' : '2px solid transparent',
        opacity: isDragging ? 0 : 1,
        userSelect: 'none',
        touchAction: 'none',
      }}
      {...attributes}
      {...listeners}
      onClick={() => { onSelect?.(); useTabs.getState().setActiveTab(slot.tabIds[0]); }}
    >
      {isMergeTarget && <MergeOverlay label="Add pane" />}

      {/* Stack icon */}
      <SquaresFour
        size={14} weight="bold"
        style={{ flexShrink: 0, color: act ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}
      />

      {/* Label */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.2 }}>
        <span style={{ fontSize: 12.5, fontWeight: act ? 500 : 400, color: act ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {firstLabel}{count > 1 ? ` +${count - 1}` : ''}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
          {count} pane{count !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Unmerge (dissolve group; tabs stay open) */}
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); useGroups.getState().unmerge(slot.groupId); }}
        title="Unmerge — split back into individual tabs"
        style={iconBtn}
      >
        <ArrowsOut size={13} />
      </button>

      {/* Close all tabs in the group */}
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); useGroups.getState().closeGroup(slot.groupId); }}
        title="Close all panes in group"
        style={iconBtn}
      >×</button>
    </div>
  );
}

/* Drag-overlay ghost for a group chip */
function GroupChipGhost({ slot }: { slot: GroupSlot }) {
  const byProject  = useTabs((s) => s.byProject);
  const count      = slot.tabIds.length;
  const firstLabel = findTerminal(byProject, slot.tabIds[0])?.label ?? 'tab';

  return (
    <div style={{
      height: BAR_H, display: 'flex', alignItems: 'center', gap: 7,
      padding: '0 8px 0 12px',
      minWidth: GRP_MIN_W, maxWidth: GRP_MAX_W,
      background: 'var(--color-pane)',
      borderRight: '1px solid var(--color-border)',
      borderBottom: '2px solid var(--color-accent)',
      opacity: 0.92,
      boxShadow: '0 8px 28px rgba(0,0,0,.5)',
      cursor: 'grabbing',
      userSelect: 'none',
    }}>
      <SquaresFour size={14} weight="bold" style={{ flexShrink: 0, color: 'var(--color-accent)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.2 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {firstLabel}{count > 1 ? ` +${count - 1}` : ''}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
          {count} pane{count !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Inner bar — full grouped/sortable implementation
   ═══════════════════════════════════════════════════════════════════════ */
function GroupedTabBarInner({ onSelect }: { onSelect?: () => void }) {
  const openTabIds = useTabs((s) => s.openTabIds);
  const groups     = useGroups((s) => s.groups);
  const tabGroup   = useGroups((s) => s.tabGroup);

  /* ── Merge target: ref for reliable read in onDragEnd + state for render ── */
  const mergeTargetRef               = useRef<string | null>(null);
  const [mergeTarget, _setMergeTarget] = useState<string | null>(null);
  function setMergeTarget(v: string | null) {
    mergeTargetRef.current = v;
    _setMergeTarget(v);
  }

  /* ── Active dragging slot id ─────────────────────────────────────── */
  const [activeId, setActiveId] = useState<string | null>(null);

  /* ── Build display slots ─────────────────────────────────────────── */
  const slots: TabSlot[] = useMemo(() => {
    const seenGroups = new Set<string>();
    const result: TabSlot[] = [];
    for (const tabId of openTabIds) {
      const gid = tabGroup[tabId];
      if (gid) {
        if (!seenGroups.has(gid)) {
          seenGroups.add(gid);
          const g = groups[gid];
          if (g) {
            result.push({
              kind: 'group',
              id: `group:${gid}`,
              groupId: gid,
              tabIds: leafTabIds(g.layout),
            });
          }
        }
        // else: already added the group chip for this group
      } else {
        result.push({ kind: 'single', id: tabId, tabId });
      }
    }
    return result;
  }, [openTabIds, tabGroup, groups]);

  /* ── Active slot (for DragOverlay render) ───────────────────────── */
  const activeSlot = activeId ? (slots.find((s) => s.id === activeId) ?? null) : null;

  /* ── Sensors ─────────────────────────────────────────────────────── */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
  );

  /* ── Handlers ────────────────────────────────────────────────────── */
  function onDragStart({ active }: DragStartEvent) {
    setActiveId(String(active.id));
    setMergeTarget(null);
  }

  function onDragMove({ over, active }: DragMoveEvent) {
    if (!over || String(over.id) === String(active.id)) {
      setMergeTarget(null);
      return;
    }

    const dragId    = String(active.id);
    const overId    = String(over.id);
    const dragSlot  = slots.find((s) => s.id === dragId);
    const overSlot  = slots.find((s) => s.id === overId);

    // Only single tabs can initiate a merge
    if (!dragSlot || dragSlot.kind !== 'single' || !overSlot) {
      setMergeTarget(null);
      return;
    }

    // Cannot merge into a full group
    if (overSlot.kind === 'group') {
      const g = groups[overSlot.groupId];
      if (!g || leafCount(g.layout) >= MAX_PANES) {
        setMergeTarget(null);
        return;
      }
    }

    // Merge affordance when the dragged chip's center is within the
    // middle 60 % of the target chip (outside that → sort only).
    const overRect       = over.rect;
    const translated     = active.rect.current.translated;
    if (!translated) { setMergeTarget(null); return; }

    const activeCenterX = translated.left + translated.width / 2;
    const mergeLeft     = overRect.left + overRect.width * 0.2;
    const mergeRight    = overRect.left + overRect.width * 0.8;

    setMergeTarget(
      activeCenterX >= mergeLeft && activeCenterX <= mergeRight ? overId : null,
    );
  }

  function onDragEnd({ over, active }: DragEndEvent) {
    const dragSlotId  = String(active.id);
    const currentMerge = mergeTargetRef.current; // read ref for freshest value

    setActiveId(null);
    setMergeTarget(null);

    if (!over) return;
    const overSlotId = String(over.id);
    if (dragSlotId === overSlotId) return;

    /* ── Merge path ──────────────────────────────────────────────── */
    if (currentMerge && currentMerge === overSlotId) {
      const dragSlot  = slots.find((s) => s.id === dragSlotId);
      const overSlot  = slots.find((s) => s.id === overSlotId);
      if (!dragSlot || !overSlot || dragSlot.kind !== 'single') return;

      if (overSlot.kind === 'single') {
        // Two individual tabs → new group (left | right layout)
        const sessionId = useTabs.getState().tabSession[dragSlot.tabId] ?? '';
        useGroups.getState().merge(sessionId, dragSlot.tabId, overSlot.tabId);
        // Activate dragged tab — App.tsx will detect it's now grouped
        useTabs.getState().setActiveTab(dragSlot.tabId);
      } else {
        // Single tab dropped onto an existing group chip → add pane
        const g = groups[overSlot.groupId];
        if (g && leafCount(g.layout) < MAX_PANES) {
          useGroups.getState().addToGroup(overSlot.groupId, dragSlot.tabId);
          useTabs.getState().setActiveTab(dragSlot.tabId);
        }
      }
      return;
    }

    /* ── Sort path ───────────────────────────────────────────────── */
    const slotIds    = slots.map((s) => s.id);
    const newSlotIds = reorderIds(slotIds, dragSlotId, overSlotId);
    if (newSlotIds.every((id, i) => id === slotIds[i])) return; // no change

    // Expand slot order back to the flat openTabIds list
    const slotById = new Map(slots.map((s) => [s.id, s]));
    const newOpenTabIds: string[] = [];
    for (const sid of newSlotIds) {
      const slot = slotById.get(sid);
      if (!slot) continue;
      if (slot.kind === 'single') newOpenTabIds.push(slot.tabId);
      else newOpenTabIds.push(...slot.tabIds);
    }
    // Defensive: append any openTabIds not covered (stale data guard)
    const covered = new Set(newOpenTabIds);
    for (const id of openTabIds) if (!covered.has(id)) newOpenTabIds.push(id);

    useTabs.setState({ openTabIds: newOpenTabIds });
    persistTabs();
  }

  function onDragCancel() {
    setActiveId(null);
    setMergeTarget(null);
  }

  if (!slots.length) return null;

  return (
    <div style={{
      display: 'flex', height: BAR_H, flexShrink: 0,
      overflowX: 'auto',
      background: 'var(--color-pane)',
      borderBottom: '1px solid var(--color-border)',
    }}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <SortableContext items={slots.map((s) => s.id)} strategy={horizontalListSortingStrategy}>
          <div style={{ display: 'flex', height: '100%' }}>
            {slots.map((slot) =>
              slot.kind === 'single' ? (
                <SortableSingleChip
                  key={slot.id}
                  slot={slot}
                  onSelect={onSelect}
                  isMergeTarget={mergeTarget === slot.id}
                />
              ) : (
                <SortableGroupChip
                  key={slot.id}
                  slot={slot}
                  onSelect={onSelect}
                  isMergeTarget={mergeTarget === slot.id}
                />
              ),
            )}
          </div>
        </SortableContext>

        {createPortal(
          <DragOverlay dropAnimation={null}>
            {activeSlot?.kind === 'single' && <SingleTabGhost slot={activeSlot} />}
            {activeSlot?.kind === 'group'  && <GroupChipGhost slot={activeSlot} />}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Public export — drop-in replacement for <TabBar/>
   ═══════════════════════════════════════════════════════════════════════ */
export function GroupedTabBar({ onSelect }: { onSelect?: () => void }) {
  const multiPane = useSettings((s) => s.multiPane);
  const mode      = useViewMode((s) => s.mode);

  if (mode !== 'operator' || !multiPane) {
    return <ClassicTabBar onSelect={onSelect} />;
  }
  return <GroupedTabBarInner onSelect={onSelect} />;
}
