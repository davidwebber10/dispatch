import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BoardCard } from './BoardCard';
import type { BoardCardModel } from './boardColumn';

function makeCard(overrides: Partial<BoardCardModel> = {}): BoardCardModel {
  return {
    terminalId: 't1',
    projectId: 'p1',
    projectName: 'dispatch',
    label: 'Thread Naming',
    column: 'needs_help',
    detail: 'Should renames apply retroactively?',
    inferred: false,
    pending: false,
    overridden: false,
    ...overrides,
  };
}

function makeCallbacks() {
  return {
    onOpen: vi.fn(),
    onAcknowledge: vi.fn(),
    onDismissInferred: vi.fn(),
    onOverride: vi.fn(),
  };
}

type Callbacks = ReturnType<typeof makeCallbacks>;

// The exact weakness this guards against: clicking every control in one render and then
// asserting each spy saw one call passes even if two handlers are swapped. Asserting the
// OTHER three were never called, on a fresh render per case, catches that.
function assertOnlyFired(cbs: Callbacks, fired: keyof Callbacks) {
  (Object.keys(cbs) as (keyof Callbacks)[]).forEach((key) => {
    if (key === fired) expect(cbs[key]).toHaveBeenCalledTimes(1);
    else expect(cbs[key]).not.toHaveBeenCalled();
  });
}

// jsdom's CSSOM re-serializes rgba() with spaces + a leading zero regardless of how it was
// authored, so string-matching the mockup's compact `rgba(232,176,75,.55)` literally would
// fail even though the color is correct. Parse channels out instead of trusting formatting.
function rgbaChannels(css: string): number[] {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return [];
  return m[1].split(',').map((s) => parseFloat(s.trim()));
}

describe('BoardCard — needs help, declared', () => {
  it('renders the project tag, label, italic question, and an Answer action', () => {
    render(<BoardCard card={makeCard()} {...makeCallbacks()} />);
    expect(screen.getByText('dispatch')).toBeInTheDocument();
    expect(screen.getByText('Thread Naming')).toBeInTheDocument();
    const question = screen.getByText('"Should renames apply retroactively?"');
    expect(question).toHaveStyle({ fontStyle: 'italic' });
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument();
    expect(screen.queryByText('~')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('uses the full-strength amber border', () => {
    render(<BoardCard card={makeCard()} {...makeCallbacks()} />);
    const el = screen.getByTestId('board-card');
    expect(rgbaChannels(el.style.borderColor)).toEqual([232, 176, 75, 0.55]);
  });

  it('clicking Answer fires onOpen, and only onOpen', () => {
    const cbs = makeCallbacks();
    render(<BoardCard card={makeCard()} {...cbs} />);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    assertOnlyFired(cbs, 'onOpen');
    expect(cbs.onOpen).toHaveBeenCalledWith('t1');
  });
});

describe('BoardCard — needs help, inferred', () => {
  const inferredCard = () =>
    makeCard({
      label: 'Rail — archived agents',
      detail: '…does that look right to you?',
      inferred: true,
    });

  it('renders the ~ marker plus Open and a dismiss control, not an Answer button', () => {
    render(<BoardCard card={inferredCard()} {...makeCallbacks()} />);
    expect(screen.getByText('~')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument();
  });

  it('uses a dimmer amber border than a declared ask', () => {
    render(<BoardCard card={inferredCard()} {...makeCallbacks()} />);
    const el = screen.getByTestId('board-card');
    expect(rgbaChannels(el.style.borderColor)).toEqual([232, 176, 75, 0.3]);
  });

  it('clicking Open fires onOpen, and only onOpen', () => {
    const cbs = makeCallbacks();
    render(<BoardCard card={inferredCard()} {...cbs} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    assertOnlyFired(cbs, 'onOpen');
    expect(cbs.onOpen).toHaveBeenCalledWith('t1');
  });

  it('clicking the dismiss control fires onDismissInferred, and only onDismissInferred', () => {
    const cbs = makeCallbacks();
    render(<BoardCard card={inferredCard()} {...cbs} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    assertOnlyFired(cbs, 'onDismissInferred');
    expect(cbs.onDismissInferred).toHaveBeenCalledWith('t1');
  });
});

describe('BoardCard — complete', () => {
  const completeCard = () =>
    makeCard({ column: 'complete', detail: 'shipped v2.6.0 · 1 Critical fixed' });

  it('renders the outcome line and a check-off control', () => {
    render(<BoardCard card={completeCard()} {...makeCallbacks()} />);
    expect(screen.getByText('✓ shipped v2.6.0 · 1 Critical fixed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  it('uses the blue complete border', () => {
    render(<BoardCard card={completeCard()} {...makeCallbacks()} />);
    const el = screen.getByTestId('board-card');
    expect(rgbaChannels(el.style.borderColor)).toEqual([90, 141, 214, 0.5]);
  });

  it('clicking the check-off fires onAcknowledge, and only onAcknowledge', () => {
    const cbs = makeCallbacks();
    render(<BoardCard card={completeCard()} {...cbs} />);
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    assertOnlyFired(cbs, 'onAcknowledge');
    expect(cbs.onAcknowledge).toHaveBeenCalledWith('t1');
  });
});

describe('BoardCard — working, live', () => {
  const liveCard = () =>
    makeCard({ column: 'working', detail: 'running · 4m · opus', pending: false });

  it('renders a solid border and the ● marker', () => {
    render(<BoardCard card={liveCard()} {...makeCallbacks()} />);
    const el = screen.getByTestId('board-card');
    expect(el.style.borderStyle).toBe('solid');
    expect(screen.getByText('● running · 4m · opus')).toBeInTheDocument();
  });

  it('clicking the card (its only control) fires onOpen, and only onOpen', () => {
    const cbs = makeCallbacks();
    render(<BoardCard card={liveCard()} {...cbs} />);
    fireEvent.click(screen.getByTestId('board-card'));
    assertOnlyFired(cbs, 'onOpen');
    expect(cbs.onOpen).toHaveBeenCalledWith('t1');
  });
});

describe('BoardCard — working, pending', () => {
  const pendingCard = () => makeCard({ column: 'working', detail: 'queued', pending: true });

  it('renders a dashed border (unlike a live card) and the ◌ marker', () => {
    render(<BoardCard card={pendingCard()} {...makeCallbacks()} />);
    const el = screen.getByTestId('board-card');
    expect(el.style.borderStyle).toBe('dashed');
    expect(screen.getByText('◌ queued')).toBeInTheDocument();
  });

  it('a live card is never dashed', () => {
    render(
      <BoardCard
        card={makeCard({ column: 'working', detail: 'running', pending: false })}
        {...makeCallbacks()}
      />
    );
    expect(screen.getByTestId('board-card').style.borderStyle).not.toBe('dashed');
  });
});

// A blocked card is a Working pending card — same dashed/dimmed treatment as queued/scheduled —
// but its line names what it's waiting on rather than the generic pending text. `card.blocker`
// (not `card.detail`) is what drives this: undefined means "not a blocked card at all", '' means
// "blocked but no text supplied" (see boardColumn.ts's toBoardCard).
describe('BoardCard — working, blocked', () => {
  it('renders behind "<blocker>" with the agent-supplied text', () => {
    const card = makeCard({ column: 'working', pending: true, detail: 'blocked', blocker: 'Sync SKU catalog' });
    render(<BoardCard card={card} {...makeCallbacks()} />);
    expect(screen.getByText('◌ behind "Sync SKU catalog"')).toBeInTheDocument();
  });

  it('falls back to a bare "blocked" (not empty quotes) when no blocker text was supplied', () => {
    const card = makeCard({ column: 'working', pending: true, detail: 'blocked', blocker: '' });
    render(<BoardCard card={card} {...makeCallbacks()} />);
    expect(screen.getByText('◌ blocked')).toBeInTheDocument();
    expect(screen.queryByText(/behind/)).not.toBeInTheDocument();
    expect(screen.queryByText(/""/)).not.toBeInTheDocument();
  });

  it('uses the same dashed, dimmed treatment as a queued pending card', () => {
    const card = makeCard({ column: 'working', pending: true, detail: 'blocked', blocker: 'Sync SKU catalog' });
    render(<BoardCard card={card} {...makeCallbacks()} />);
    const el = screen.getByTestId('board-card');
    expect(el.style.borderStyle).toBe('dashed');
    expect(el.style.opacity).toBe('0.62');
  });
});

describe('BoardCard — resting', () => {
  it('renders the outcome line with a check when one exists', () => {
    const card = makeCard({ column: 'resting', detail: 'shipped v2.1.0 · 3d' });
    render(<BoardCard card={card} {...makeCallbacks()} />);
    expect(screen.getByText('✓ shipped v2.1.0 · 3d')).toBeInTheDocument();
  });

  it('renders the never-started fallback verbatim, with no check mark', () => {
    const card = makeCard({ column: 'resting', detail: 'new — no work yet' });
    render(<BoardCard card={card} {...makeCallbacks()} />);
    expect(screen.getByText('new — no work yet')).toBeInTheDocument();
    expect(screen.queryByText(/^✓/)).not.toBeInTheDocument();
  });

  it('clicking the card (its only control) fires onOpen, and only onOpen', () => {
    const cbs = makeCallbacks();
    render(
      <BoardCard card={makeCard({ column: 'resting', detail: 'new — no work yet' })} {...cbs} />
    );
    fireEvent.click(screen.getByTestId('board-card'));
    assertOnlyFired(cbs, 'onOpen');
    expect(cbs.onOpen).toHaveBeenCalledWith('t1');
  });
});
