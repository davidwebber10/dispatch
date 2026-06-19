export function AgentsEmpty({ onNew }: { onNew: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, padding: 40, textAlign: 'center' }}>
      <div style={{ width: 60, height: 60, borderRadius: 15, background: 'var(--color-pane)', border: '1px solid var(--color-border)', boxShadow: '0 10px 30px -14px rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, color: 'var(--color-accent)' }}>◉</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 17, fontWeight: 600 }}>No agents yet</span>
        <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 380 }}>
          Create an agent to run standing instructions — like triaging flaky tests or opening dependency PRs — on a schedule.
        </span>
      </div>
      <button onClick={onNew} style={{ height: 36, padding: '0 16px', background: 'var(--color-accent)', border: 'none', borderRadius: 9, color: '#08240F', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>+ New Agent</button>
    </div>
  );
}
