import { useState, useRef } from 'react';
import { useGroups } from './store';
import { PaneTree } from './PaneTree';
import { leafCount, leafTabIds, defaultLayout } from './types';

// ---------------------------------------------------------------------------
// Block geometry helpers
// ---------------------------------------------------------------------------

// Each block is [x, y, w, h] as fractions of the container (0–1).
// These mirror the defaultLayout shapes:
//   2 → left | right
//   3 → top-left, top-right, bottom-full
//   4 → 2×2 grid
type BlockRect = [number, number, number, number]; // [x, y, w, h]

function getBlocks(n: number): BlockRect[] {
  switch (n) {
    case 2:
      return [
        [0,   0, 0.5, 1],   // 0: left
        [0.5, 0, 0.5, 1],   // 1: right
      ];
    case 3:
      return [
        [0,   0,   0.5, 0.5], // 0: top-left
        [0.5, 0,   0.5, 0.5], // 1: top-right
        [0,   0.5, 1,   0.5], // 2: bottom-full
      ];
    case 4:
      return [
        [0,   0,   0.5, 0.5], // 0: top-left
        [0.5, 0,   0.5, 0.5], // 1: top-right
        [0,   0.5, 0.5, 0.5], // 2: bottom-left
        [0.5, 0.5, 0.5, 0.5], // 3: bottom-right
      ];
    default:
      return [[0, 0, 1, 1]];
  }
}

/** Return the index of the block that contains (cx, cy), or null if none. */
function hitBlock(cx: number, cy: number, rect: DOMRect, blocks: BlockRect[]): number | null {
  const nx = (cx - rect.left) / rect.width;
  const ny = (cy - rect.top) / rect.height;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  for (let i = 0; i < blocks.length; i++) {
    const [bx, by, bw, bh] = blocks[i];
    if (nx >= bx && nx < bx + bw && ny >= by && ny < by + bh) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block label helpers — a short human label per block position
// ---------------------------------------------------------------------------
const BLOCK_LABELS: Record<number, string[]> = {
  2: ['Left',       'Right'],
  3: ['Top left',   'Top right',   'Bottom'],
  4: ['Top left',   'Top right',   'Bottom left', 'Bottom right'],
};

// ---------------------------------------------------------------------------
// GroupedPaneView
// ---------------------------------------------------------------------------

/**
 * Renders a group: a <PaneTree> of all panes with interactive splitters.
 *
 * Owns the REORGANIZE interaction:
 *   1. A grip-drag from any PaneFrame (onMoveLeaf) enters reorganize mode.
 *   2. The content scales down to 0.82 and N drop-blocks appear as an overlay.
 *   3. Moving the pointer over a block highlights it; releasing commits the drop.
 *   4. Escape or a release outside any block cancels.
 *
 * Commit: reads fresh store state, removes the dragged tab from its current
 * position, inserts it at the target block index, then calls
 * store.reorganize(groupId, defaultLayout(newOrder)).
 */
export function GroupedPaneView({ groupId }: { groupId: string }) {
  const group = useGroups((s) => s.groups[groupId]);

  // reorganizeTabId: which pane's grip is being dragged; null = idle
  const [reorganizeTabId, setReorganizeTabId] = useState<string | null>(null);
  // hoveredBlock: which drop-block the pointer is currently over
  const [hoveredBlock, setHoveredBlock] = useState<number | null>(null);

  // Ref so the window handler can read the latest hovered block without stale closure
  const hoveredBlockRef = useRef<number | null>(null);

  // Container used for hit-testing pointer coordinates against drop blocks
  const containerRef = useRef<HTMLDivElement>(null);

  if (!group) return null;

  const paneCount = leafCount(group.layout);
  const isReorganizing = reorganizeTabId !== null;
  const blocks = getBlocks(paneCount);
  const blockLabels = BLOCK_LABELS[paneCount] ?? [];

  // -------------------------------------------------------------------------
  // Reorganize drag — called from PaneFrame grip pointerdown via PaneTree
  // -------------------------------------------------------------------------
  function onMoveLeaf(tabId: string, _e: React.PointerEvent) {
    setReorganizeTabId(tabId);
    setHoveredBlock(null);
    hoveredBlockRef.current = null;

    const container = containerRef.current;
    // Snapshot the block layout at drag-start (paneCount won't change mid-drag)
    const dragBlocks = getBlocks(leafCount(useGroups.getState().groups[groupId]?.layout ?? group.layout));

    function handleMove(ev: PointerEvent) {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const b = hitBlock(ev.clientX, ev.clientY, rect, dragBlocks);
      hoveredBlockRef.current = b;
      setHoveredBlock(b);
    }

    function cleanup() {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup',   handleUp);
      window.removeEventListener('pointercancel', handleCancel);
      window.removeEventListener('keydown',     handleKey);
    }

    function exitReorganize() {
      setReorganizeTabId(null);
      setHoveredBlock(null);
      hoveredBlockRef.current = null;
    }

    function commitDrop(targetBlock: number) {
      const { groups } = useGroups.getState();
      const g = groups[groupId];
      if (!g) return;
      const ids = leafTabIds(g.layout);
      // Remove the dragged tab from its current slot
      const others = ids.filter((id) => id !== tabId);
      // Insert at the target block index (clamped to valid range)
      const insertAt = Math.min(targetBlock, others.length);
      const newOrder = [
        ...others.slice(0, insertAt),
        tabId,
        ...others.slice(insertAt),
      ];
      useGroups.getState().reorganize(groupId, defaultLayout(newOrder));
    }

    function handleUp() {
      const block = hoveredBlockRef.current;
      cleanup();
      exitReorganize();
      if (block !== null) commitDrop(block);
    }

    function handleCancel() {
      cleanup();
      exitReorganize();
    }

    function handleKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') handleCancel();
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup',   handleUp);
    window.addEventListener('pointercancel', handleCancel);
    window.addEventListener('keydown',     handleKey);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        display: 'flex',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* ---- Pane content — scales down during reorganize ---- */}
      <div
        style={{
          display:    'flex',
          flex:        1,
          minWidth:    0,
          minHeight:   0,
          overflow:   'hidden',
          transform:   isReorganizing ? 'scale(0.82)' : 'scale(1)',
          transition: 'transform 0.2s ease',
          transformOrigin: 'center center',
          borderRadius: isReorganizing ? 10 : 0,
          // Pointer events on the content are blocked by the overlay below
          // so xterm canvases etc. don't capture during reorganize.
        }}
      >
        <PaneTree
          node={group.layout}
          groupId={groupId}
          path=""
          onMoveLeaf={onMoveLeaf}
        />
      </div>

      {/* ---- Reorganize overlay ---- */}
      {isReorganizing && (
        <div
          style={{
            position:      'absolute',
            inset:          0,
            pointerEvents: 'auto', // blocks interaction with scaled panes
            cursor:        'grabbing',
            // Subtle dark scrim so the drop blocks pop
            background:    'color-mix(in srgb, var(--color-base) 35%, transparent)',
          }}
        >
          {blocks.map(([bx, by, bw, bh], i) => {
            const isHov = hoveredBlock === i;
            return (
              <div
                key={i}
                style={{
                  position:   'absolute',
                  left:       `${bx * 100}%`,
                  top:        `${by * 100}%`,
                  width:      `${bw * 100}%`,
                  height:     `${bh * 100}%`,
                  boxSizing:  'border-box',
                  border:     `2px solid ${
                    isHov
                      ? 'var(--color-accent)'
                      : 'color-mix(in srgb, var(--color-border) 80%, transparent)'
                  }`,
                  background: isHov
                    ? 'color-mix(in srgb, var(--color-accent) 20%, transparent)'
                    : 'color-mix(in srgb, var(--color-elevated) 45%, transparent)',
                  borderRadius: 10,
                  transition: 'border-color .12s ease, background .12s ease',
                  display:        'flex',
                  alignItems:     'center',
                  justifyContent: 'center',
                  // inner padding so the label doesn't hug the border
                  padding: '0 8px',
                }}
              >
                <span
                  style={{
                    fontSize:   11,
                    fontWeight: 500,
                    color:      isHov
                      ? 'var(--color-accent)'
                      : 'var(--color-text-tertiary)',
                    userSelect: 'none',
                    letterSpacing: '0.02em',
                    transition: 'color .12s ease',
                    textAlign:  'center',
                    pointerEvents: 'none',
                  }}
                >
                  {blockLabels[i] ?? `Block ${i + 1}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
