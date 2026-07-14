import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor, useSensor, useSensors,
  closestCenter, type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { reorderIds } from '../../lib/reorder';

interface SortableListProps<T extends { id: string }> {
  items: T[];
  onReorder: (orderedIds: string[]) => void;
  renderItem: (item: T, opts: { dragging: boolean }) => ReactNode;
  renderOverlay?: (item: T) => ReactNode;
  disabled?: boolean;
}

// The stock KeyboardSensor lifts the row on Space/Enter from ANY descendant —
// React synthetic events bubble through the component tree (portals included),
// so a space typed into a rename modal's input, or Space on a focused child
// button, reached the sensor, which preventDefault()ed (swallowing the
// keystroke) and toggled drag pickup. Only treat the key as a drag intent when
// the row wrapper itself is the focused element.
class RowKeyboardSensor extends KeyboardSensor {
  static activators: typeof KeyboardSensor.activators = [{
    eventName: 'onKeyDown',
    handler: (event, ...rest) =>
      event.target === event.currentTarget && KeyboardSensor.activators[0].handler(event, ...rest),
  }];
}

function SortableRow({ id, children }: { id: string; children: (dragging: boolean) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, position: 'relative' }}
      {...attributes}
      {...listeners}
    >
      <div style={{ opacity: isDragging ? 0 : 1 }}>{children(isDragging)}</div>
      {isDragging && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 8, pointerEvents: 'none',
          border: '1.5px dashed color-mix(in srgb, var(--color-accent) 55%, transparent)',
          background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
        }} />
      )}
    </div>
  );
}

export function SortableList<T extends { id: string }>({ items, onReorder, renderItem, renderOverlay, disabled }: SortableListProps<T>) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(RowKeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (disabled) return <>{items.map((it) => <div key={it.id}>{renderItem(it, { dragging: false })}</div>)}</>;

  const activeItem = activeId ? items.find((i) => i.id === activeId) ?? null : null;

  function onDragStart(e: DragStartEvent) { setActiveId(String(e.active.id)); }
  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const next = reorderIds(items.map((i) => i.id), String(e.active.id), e.over ? String(e.over.id) : null);
    const cur = items.map((i) => i.id);
    if (next.some((id, i) => id !== cur[i])) onReorder(next);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter}
      onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((it) => (
          <SortableRow key={it.id} id={it.id}>{(dragging) => renderItem(it, { dragging })}</SortableRow>
        ))}
      </SortableContext>
      {createPortal(
        <DragOverlay>
          {activeItem ? (
            <div className="dispatch-wiggle" style={{ transform: 'scale(1.03)', boxShadow: '0 14px 34px -10px rgba(0,0,0,.65)', borderRadius: 8, cursor: 'grabbing' }}>
              {(renderOverlay ?? ((it: T) => renderItem(it, { dragging: true })))(activeItem)}
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
