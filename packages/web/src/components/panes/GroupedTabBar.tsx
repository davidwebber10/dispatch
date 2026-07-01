/**
 * GroupedTabBar — drop-in operator tab strip with multi-pane grouping.
 *
 * Operator mode only, gated by the `multiPane` setting.  Falls back to
 * classic TabBar behaviour when either condition is false.
 *
 * Drag model (dropzones never move under the cursor):
 *  - On drag start the dragged tab lifts into a ghost that follows the cursor,
 *    and its slot becomes ONE reorder dropzone (the "vacated space").
 *  - Every OTHER tab is a MERGE dropzone; thin reorder gaps sit between them.
 *  - Drop on a tab  → merge (new group / +pane). Drop in a space → reorder.
 *  Nothing slides around mid-drag, and collisions are pointer-precise (the
 *  dropzone under the cursor wins), with live droppable measuring so the
 *  freshly-expanded spaces are hit accurately.
 *  - Group chips: stack icon + count title ("N Tabs", renameable), split
 *    (ArrowsSplit) + X close-all. Selecting a group activates its first tab
 *    (App.tsx detects the active tab is grouped and renders PaneTree).
 *
 * Do NOT import this file in more than one place at a time; it is a
 * self-contained drop-in.  Wire it into App.tsx in place of <TabBar/>.
 */

import { Fragment, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
  closestCenter,
  type CollisionDetection,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SquaresFour, ArrowsSplit, Lightning } from '@phosphor-icons/react';
import { useTabs, findTerminal, isDispatchTab, tabLabel, tabProjectId } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useSettings, useDispatchName } from '../../stores/settings';
import { useGroups } from './store';
import { leafTabIds, leafCount, MAX_PANES } from './types';

/* ── Constants ───────────────────────────────────────────────────────── */
const BAR_H      = 44;
const TAB_MIN_W  = 150;
const TAB_MAX_W  = 230;
const GRP_MIN_W  = 185;
const GRP_MAX_W  = 290;
const GAP_W      = 18; // width of a thin reorder gap between two tabs while dragging

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

/* Pointer-precise collision: prefer the droppable under the pointer (a gap or a
   tab), falling back to nearest-center only when the pointer is in a dead zone. */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCenter(args);
};

/* ═══════════════════════════════════════════════════════════════════════
   Classic TabBar fallback  (identical to components/layout/TabBar.tsx)
   Rendered when multiPane is off or mode !== 'operator'.
   ═══════════════════════════════════════════════════════════════════════ */
function ClassicTabBar({ onSelect }: { onSelect?: () => void }) {
  const openTabIds  = useTabs((s) => s.openTabIds);
  const activeTabId = useTabs((s) => s.activeTabId);
  const byProject   = useTabs((s) => s.byProject);
  const sessions    = useProjects((s) => s.sessions);
  const dispatchName = useDispatchName();

  if (!openTabIds.length) return null;

  return (
    <div style={{
      display: 'flex', height: BAR_H, flexShrink: 0,
      overflowX: 'auto',
      background: 'var(--color-pane)',
      borderBottom: '1px solid var(--color-border)',
    }}>
      {openTabIds.map((id) => {
        const proj = sessions.find((s) => s.id === tabProjectId(id, byProject));
        const act  = id === activeTabId;
        const dispatch = isDispatchTab(id);
        return (
          <div
            key={id}
            onClick={() => { onSelect?.(); useTabs.getState().setActiveTab(id); }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); useTabs.getState().closeTab(id); } }}
            style={{
              display: 'flex', alignItems: 'center', gap: dispatch ? 8 : 10,
              padding: dispatch ? '0 10px 0 13px' : '0 10px 0 15px',
              minWidth: TAB_MIN_W, maxWidth: TAB_MAX_W, flexShrink: 0,
              cursor: 'pointer',
              borderRight: '1px solid var(--color-border)',
              background:    act ? 'var(--color-base)' : 'transparent',
              borderBottom:  act ? '2px solid var(--color-accent)' : '2px solid transparent',
            }}
          >
            {dispatch && <Lightning size={14} weight="fill" style={{ flexShrink: 0, color: 'var(--color-accent)' }} />}
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.2 }}>
              <span style={{ fontSize: 12.5, fontWeight: act ? 500 : 400, color: act ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {dispatch ? dispatchName : tabLabel(id, byProject)}
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
   Dispatch (virtual) tab chip — static, non-draggable, never groupable. Lives
   in the strip like any other tab but has no backend terminal / drag behaviour.
   ═══════════════════════════════════════════════════════════════════════ */
function DispatchChip({ tabId, onSelect }: { tabId: string; onSelect?: () => void }) {
  const activeTabId = useTabs((s) => s.activeTabId);
  const byProject   = useTabs((s) => s.byProject);
  const sessions    = useProjects((s) => s.sessions);
  const dispatchName = useDispatchName();
  const proj = sessions.find((s) => s.id === tabProjectId(tabId, byProject));
  const act  = tabId === activeTabId;
  return (
    <div
      onClick={() => { onSelect?.(); useTabs.getState().setActiveTab(tabId); }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); useTabs.getState().closeTab(tabId); } }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 10px 0 13px',
        minWidth: TAB_MIN_W, maxWidth: TAB_MAX_W, flexShrink: 0,
        height: '100%', cursor: 'pointer',
        borderRight: '1px solid var(--color-border)',
        background:   act ? 'var(--color-base)' : 'transparent',
        borderBottom: act ? '2px solid var(--color-accent)' : '2px solid transparent',
        userSelect: 'none',
      }}
    >
      <Lightning size={14} weight="fill" style={{ flexShrink: 0, color: 'var(--color-accent)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.2 }}>
        <span style={{ fontSize: 12.5, fontWeight: act ? 500 : 400, color: act ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dispatchName}</span>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proj?.name ?? ''}</span>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); useTabs.getState().closeTab(tabId); }}
        title="Close tab"
        style={iconBtn}
      >×</button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Merge affordance overlay  (shown on the target tab while hovering it)
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

/* Centered accent insertion bar for a reorder dropzone that's being hovered. */
function InsertBar() {
  return (
    <div style={{
      position: 'absolute', top: 4, bottom: 4, left: '50%', transform: 'translateX(-50%)',
      width: 3, borderRadius: 2, background: 'var(--color-accent)',
      boxShadow: '0 0 6px 1px color-mix(in srgb, var(--color-accent) 70%, transparent)',
      pointerEvents: 'none',
    }} />
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Thin reorder gap between two (non-dragged) tabs.
   ═══════════════════════════════════════════════════════════════════════ */
function DropGap({ index }: { index: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `gap:${index}` });
  return (
    <div ref={setNodeRef} style={{
      position: 'relative', alignSelf: 'stretch', flexShrink: 0, width: GAP_W,
      background: isOver ? 'color-mix(in srgb, var(--color-accent) 16%, transparent)' : 'transparent',
    }}>
      {isOver && <InsertBar />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Single-tab chip.  Idle: draggable + a MERGE dropzone. While THIS tab is the
   one being dragged it renders as its vacated-space REORDER dropzone instead.
   ═══════════════════════════════════════════════════════════════════════ */
function SingleChip({ slot, index, onSelect }: { slot: SingleSlot; index: number; onSelect?: () => void }) {
  const activeTabId = useTabs((s) => s.activeTabId);
  const byProject   = useTabs((s) => s.byProject);
  const sessions    = useProjects((s) => s.sessions);

  const t    = findTerminal(byProject, slot.tabId);
  const proj = sessions.find((s) => s.id === t?.sessionId);
  const act  = slot.tabId === activeTabId;

  const { setNodeRef: dragRef, listeners, attributes, isDragging } = useDraggable({ id: slot.id });
  // One droppable whose role flips: a MERGE target when idle, the vacated-space
  // REORDER target while this tab is the one being dragged.
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: isDragging ? `gap:${index}` : `merge:${slot.id}` });
  const ref = (n: HTMLElement | null) => { dragRef(n); dropRef(n); };

  if (isDragging) {
    return (
      <div
        ref={ref}
        {...attributes}
        {...listeners}
        style={{
          position: 'relative', alignSelf: 'stretch', flexShrink: 0,
          minWidth: TAB_MIN_W, maxWidth: TAB_MAX_W,
          boxSizing: 'border-box',
          border: '1.5px dashed var(--color-border)', borderRadius: 7,
          margin: '4px 0',
          background: isOver ? 'color-mix(in srgb, var(--color-accent) 16%, transparent)' : 'color-mix(in srgb, var(--color-text-tertiary) 7%, transparent)',
        }}
      >
        {isOver && <InsertBar />}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      {...attributes}
      {...listeners}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 10px 0 15px',
        minWidth: TAB_MIN_W, maxWidth: TAB_MAX_W, flexShrink: 0,
        height: '100%',
        cursor: 'pointer',
        borderRight: '1px solid var(--color-border)',
        background:   act ? 'var(--color-base)' : 'transparent',
        borderBottom: act ? '2px solid var(--color-accent)' : '2px solid transparent',
        userSelect: 'none',
        touchAction: 'none',
      }}
      onClick={() => { onSelect?.(); useTabs.getState().setActiveTab(slot.tabId); }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); useTabs.getState().closeTab(slot.tabId); } }}
    >
      {isOver && <MergeOverlay label="Merge" />}

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

/* Drag-overlay ghost for a single tab */
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
      opacity: 0.95,
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
   Group chip.  Idle: draggable + +pane dropzone; "N Tabs" title (renameable).
   While dragged: renders as its vacated-space reorder dropzone.
   ═══════════════════════════════════════════════════════════════════════ */
function GroupChip({ slot, index, onSelect }: { slot: GroupSlot; index: number; onSelect?: () => void }) {
  const activeTabId = useTabs((s) => s.activeTabId);
  const byProject   = useTabs((s) => s.byProject);
  const name        = useGroups((s) => s.groups[slot.groupId]?.name);

  const act     = slot.tabIds.includes(activeTabId ?? '');
  const count   = slot.tabIds.length;
  const full    = count >= MAX_PANES;
  const title   = name?.trim() || `${count} Tab${count !== 1 ? 's' : ''}`;
  const members = slot.tabIds.map((id) => findTerminal(byProject, id)?.label ?? 'tab').join(', ');

  const [editing, setEditing]     = useState(false);
  const [draftName, setDraftName] = useState('');

  const { setNodeRef: dragRef, listeners, attributes, isDragging } = useDraggable({ id: slot.id });
  // A full group can't accept a +pane, so it has no merge id while idle.
  const dropId = isDragging ? `gap:${index}` : (full ? undefined : `merge:${slot.id}`);
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: dropId ?? `grp-noop:${slot.id}`, disabled: dropId == null });
  const ref = (n: HTMLElement | null) => { dragRef(n); dropRef(n); };

  function commitRename() { useGroups.getState().rename(slot.groupId, draftName); setEditing(false); }
  function startRename()  { setDraftName(name ?? ''); setEditing(true); }

  if (isDragging) {
    return (
      <div
        ref={ref}
        {...attributes}
        {...listeners}
        style={{
          position: 'relative', alignSelf: 'stretch', flexShrink: 0,
          minWidth: GRP_MIN_W, maxWidth: GRP_MAX_W,
          boxSizing: 'border-box',
          border: '1.5px dashed var(--color-border)', borderRadius: 7,
          margin: '4px 0',
          background: isOver ? 'color-mix(in srgb, var(--color-accent) 16%, transparent)' : 'color-mix(in srgb, var(--color-text-tertiary) 7%, transparent)',
        }}
      >
        {isOver && <InsertBar />}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      {...attributes}
      {...listeners}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '0 8px 0 12px',
        minWidth: GRP_MIN_W, maxWidth: GRP_MAX_W, flexShrink: 0,
        height: '100%',
        cursor: 'pointer',
        borderRight: '1px solid var(--color-border)',
        background:   act ? 'var(--color-base)' : 'transparent',
        borderBottom: act ? '2px solid var(--color-accent)' : '2px solid transparent',
        userSelect: 'none',
        touchAction: 'none',
      }}
      onClick={() => { if (editing) return; onSelect?.(); useTabs.getState().setActiveTab(slot.tabIds[0]); }}
    >
      {isOver && <MergeOverlay label="Add pane" />}

      {/* Stack icon */}
      <SquaresFour
        size={14} weight="bold"
        style={{ flexShrink: 0, color: act ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}
      />

      {/* Label — double-click the title to rename the group */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.2 }}>
        {editing ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
            placeholder={`${count} Tabs`}
            style={{ font: '500 12.5px var(--font-sans)', color: '#fff', background: 'var(--color-elevated)', border: '1px solid var(--color-accent)', borderRadius: 4, padding: '1px 4px', width: '100%', minWidth: 0, outline: 'none' }}
          />
        ) : (
          <>
            <span
              onDoubleClick={(e) => { e.stopPropagation(); startRename(); }}
              title="Double-click to rename group"
              style={{ fontSize: 12.5, fontWeight: act ? 500 : 400, color: act ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {title}
            </span>
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {members}
            </span>
          </>
        )}
      </div>

      {/* Split — dissolve the group; tabs return to individual tabs with their original names */}
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); useGroups.getState().unmerge(slot.groupId); }}
        title="Split — back into individual tabs"
        style={iconBtn}
      >
        <ArrowsSplit size={13} />
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
  const byProject = useTabs((s) => s.byProject);
  const name      = useGroups((s) => s.groups[slot.groupId]?.name);
  const count     = slot.tabIds.length;
  const title     = name?.trim() || `${count} Tab${count !== 1 ? 's' : ''}`;
  const members   = slot.tabIds.map((id) => findTerminal(byProject, id)?.label ?? 'tab').join(', ');

  return (
    <div style={{
      height: BAR_H, display: 'flex', alignItems: 'center', gap: 7,
      padding: '0 8px 0 12px',
      minWidth: GRP_MIN_W, maxWidth: GRP_MAX_W,
      background: 'var(--color-pane)',
      borderRight: '1px solid var(--color-border)',
      borderBottom: '2px solid var(--color-accent)',
      opacity: 0.95,
      boxShadow: '0 8px 28px rgba(0,0,0,.5)',
      cursor: 'grabbing',
      userSelect: 'none',
    }}>
      <SquaresFour size={14} weight="bold" style={{ flexShrink: 0, color: 'var(--color-accent)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.2 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {members}
        </span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Inner bar — gap/merge drag implementation
   ═══════════════════════════════════════════════════════════════════════ */
function GroupedTabBarInner({ onSelect }: { onSelect?: () => void }) {
  const openTabIds = useTabs((s) => s.openTabIds);
  const groups     = useGroups((s) => s.groups);
  const tabGroup   = useGroups((s) => s.tabGroup);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [, setOverId]           = useState<string | null>(null); // re-render on over change (isOver reads live)

  /* ── Build display slots ─────────────────────────────────────────── */
  const seenGroups = new Set<string>();
  const slots: TabSlot[] = [];
  for (const tabId of openTabIds) {
    const gid = tabGroup[tabId];
    if (gid) {
      if (!seenGroups.has(gid)) {
        seenGroups.add(gid);
        const g = groups[gid];
        if (g) slots.push({ kind: 'group', id: `group:${gid}`, groupId: gid, tabIds: leafTabIds(g.layout) });
      }
    } else {
      slots.push({ kind: 'single', id: tabId, tabId });
    }
  }

  const dragIdx    = activeId ? slots.findIndex((s) => s.id === activeId) : -1;
  const activeSlot = dragIdx >= 0 ? slots[dragIdx] : null;

  /* ── Sensors: mouse = distance (no hold) so quick desktop drags work;
       touch = short long-press so the bar can still be swipe-scrolled. ── */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  function applySlotOrder(orderedSlotIds: string[]) {
    const slotById = new Map(slots.map((s) => [s.id, s]));
    const next: string[] = [];
    for (const sid of orderedSlotIds) {
      const slot = slotById.get(sid);
      if (!slot) continue;
      if (slot.kind === 'single') next.push(slot.tabId);
      else next.push(...slot.tabIds);
    }
    const covered = new Set(next);
    for (const id of openTabIds) if (!covered.has(id)) next.push(id); // stale-data guard
    useTabs.setState({ openTabIds: next });
    persistTabs();
  }

  function onDragStart({ active }: DragStartEvent) {
    setActiveId(String(active.id));
    setOverId(null);
  }

  function onDragOver({ over }: DragOverEvent) {
    setOverId(over ? String(over.id) : null);
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    const dragId = String(active.id);
    setActiveId(null);
    setOverId(null);
    if (!over) return;
    const target = String(over.id);

    /* ── Merge: dropped on a tab/group ──────────────────────────────── */
    if (target.startsWith('merge:')) {
      const overSlotId = target.slice('merge:'.length);
      if (overSlotId === dragId) return;
      const dragSlot = slots.find((s) => s.id === dragId);
      const overSlot = slots.find((s) => s.id === overSlotId);
      if (!dragSlot || !overSlot || dragSlot.kind !== 'single') return; // only a single tab merges in
      if (overSlot.kind === 'single') {
        const sessionId = useTabs.getState().tabSession[dragSlot.tabId] ?? '';
        useGroups.getState().merge(sessionId, dragSlot.tabId, overSlot.tabId);
        useTabs.getState().setActiveTab(dragSlot.tabId); // App.tsx detects it's now grouped
      } else {
        const g = groups[overSlot.groupId];
        if (g && leafCount(g.layout) < MAX_PANES) {
          useGroups.getState().addToGroup(overSlot.groupId, dragSlot.tabId);
          useTabs.getState().setActiveTab(dragSlot.tabId);
        }
      }
      return;
    }

    /* ── Reorder: dropped in a gap / the vacated space (index = position) ── */
    if (target.startsWith('gap:')) {
      const gapIndex = Number(target.slice('gap:'.length));
      const order = slots.map((s) => s.id);
      const di = order.indexOf(dragId);
      if (di === -1) return;
      const without = order.filter((id) => id !== dragId);
      const insertAt = gapIndex > di ? gapIndex - 1 : gapIndex;
      without.splice(insertAt, 0, dragId);
      if (without.every((id, i) => id === order[i])) return; // dropped in its own space → no-op
      applySlotOrder(without);
    }
  }

  function onDragCancel() {
    setActiveId(null);
    setOverId(null);
  }

  if (!slots.length) return null;

  const dragging = dragIdx >= 0;

  return (
    <div style={{
      display: 'flex', height: BAR_H, flexShrink: 0,
      overflowX: 'auto',
      background: 'var(--color-pane)',
      borderBottom: '1px solid var(--color-border)',
    }}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div style={{ display: 'flex', height: '100%' }}>
          {slots.map((slot, i) => (
            <Fragment key={slot.id}>
              {/* thin reorder gap before slot i — only while dragging, and not
                  flanking the dragged tab (its vacated space already covers that). */}
              {dragging && i !== dragIdx && i !== dragIdx + 1 && <DropGap index={i} />}
              {slot.kind === 'single'
                ? (isDispatchTab(slot.tabId)
                    ? <DispatchChip tabId={slot.tabId} onSelect={onSelect} />
                    : <SingleChip slot={slot} index={i} onSelect={onSelect} />)
                : <GroupChip  slot={slot} index={i} onSelect={onSelect} />}
            </Fragment>
          ))}
          {/* trailing reorder gap after the last slot */}
          {dragging && slots.length !== dragIdx + 1 && <DropGap index={slots.length} />}
        </div>

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

  if (!multiPane) {
    return <ClassicTabBar onSelect={onSelect} />;
  }
  return <GroupedTabBarInner onSelect={onSelect} />;
}
