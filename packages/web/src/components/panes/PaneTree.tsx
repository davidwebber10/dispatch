import type { PaneNode } from './types';
import { useGroups } from './store';
import { Splitter } from './Splitter';
import { PaneFrame } from './PaneFrame';

/** Recursively render a PaneNode for one group.
 *  - leaf  -> <PaneFrame/> (X removes from group; grip starts a reorganize-drag).
 *  - split -> a flex container (row|col) with child A, a <Splitter/>, and child B.
 *
 *  `path` addresses the *current* split node from the group root as a string of
 *  'a'/'b' steps (root = ''); children recurse with path+'a' / path+'b' so a
 *  Splitter's setRatio targets exactly its own node. */
export function PaneTree({ node, groupId, path = '', onMoveLeaf }: {
  node: PaneNode;
  groupId: string;
  path?: string;
  /** Start a reorganize-drag for a pane; the grip's pointer event is forwarded. */
  onMoveLeaf?: (tabId: string, e: React.PointerEvent) => void;
}) {
  if (node.kind === 'leaf') {
    return (
      <PaneFrame
        tabId={node.tabId}
        onClose={() => useGroups.getState().removeFromGroup(groupId, node.tabId)}
        onMoveStart={onMoveLeaf ? (e) => onMoveLeaf(node.tabId, e) : undefined}
      />
    );
  }

  const isRow = node.dir === 'row';
  const side: React.CSSProperties = { minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' };

  return (
    <div style={{ display: 'flex', flexDirection: isRow ? 'row' : 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      <div style={{ ...side, flex: `${node.ratio} 1 0%` }}>
        <PaneTree node={node.a} groupId={groupId} path={path + 'a'} onMoveLeaf={onMoveLeaf} />
      </div>
      <Splitter dir={node.dir} ratio={node.ratio} onRatio={(r) => useGroups.getState().setRatio(groupId, path, r)} />
      <div style={{ ...side, flex: `${1 - node.ratio} 1 0%` }}>
        <PaneTree node={node.b} groupId={groupId} path={path + 'b'} onMoveLeaf={onMoveLeaf} />
      </div>
    </div>
  );
}
