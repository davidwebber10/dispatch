import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error('the view broke');
  return <div>the view works</div>;
}

describe('ErrorBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { shouldThrow = true; errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errorSpy.mockRestore(); });

  it('shows the fallback when a child throws', () => {
    render(<ErrorBoundary scope="test view"><Bomb /></ErrorBoundary>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This part of Dispatch stopped because of an error.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
    // The log names the scope and carries the error. No network call is made.
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('test view') && c[1] instanceof Error)).toBe(true);
  });

  it('Try again renders the child again', () => {
    render(<ErrorBoundary scope="test view"><Bomb /></ErrorBoundary>);
    expect(screen.queryByText('the view works')).toBeNull();
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('the view works')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a throw in one view leaves the app shell on screen', () => {
    render(
      <ErrorBoundary scope="root">
        <nav aria-label="shell">the app shell</nav>
        <ErrorBoundary scope="view"><Bomb /></ErrorBoundary>
      </ErrorBoundary>,
    );
    expect(screen.getByLabelText('shell')).toHaveTextContent('the app shell');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('a custom fallback gets the error and reset', () => {
    render(
      <ErrorBoundary scope="custom" fallback={({ error, reset }) => <button onClick={reset}>again: {error.message}</button>}>
        <Bomb />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'again: the view broke' }));
    expect(screen.getByText('the view works')).toBeInTheDocument();
  });

  it('Copy details puts the scope, the message and the stack on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ErrorBoundary scope="test view"><Bomb /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain('test view');
    expect(text).toContain('the view broke');
  });
});
