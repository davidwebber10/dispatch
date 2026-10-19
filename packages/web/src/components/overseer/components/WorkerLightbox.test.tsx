import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkerLightbox } from './WorkerLightbox';
import { useOverseer } from '../store';

vi.mock('../../tabs/chat/ChatView', () => ({ ChatView: () => <div>chat</div> }));
vi.mock('./AgentDetailHeader', () => ({ AgentDetailHeader: () => <div>header</div> }));

describe('WorkerLightbox onOpenFull', () => {
  it('shows "Open in Threads" only when onOpenFull is passed', () => {
    useOverseer.setState({ workerLightboxId: 't9' });
    const { rerender } = render(<WorkerLightbox />);
    expect(screen.queryByRole('button', { name: 'Open in Threads' })).not.toBeInTheDocument();
    const onOpenFull = vi.fn();
    rerender(<WorkerLightbox onOpenFull={onOpenFull} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Threads' }));
    expect(onOpenFull).toHaveBeenCalledWith('t9');
  });
});
