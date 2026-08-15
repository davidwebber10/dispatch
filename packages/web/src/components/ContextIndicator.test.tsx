import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextIndicator, modelDisplayName } from './ContextIndicator';

describe('modelDisplayName', () => {
  it('shortens Claude model ids', () => {
    expect(modelDisplayName('claude-opus-4-6')).toBe('Opus 4.6');
    expect(modelDisplayName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5'); // date dropped
  });

  it('handles non-Claude ids and absent input', () => {
    expect(modelDisplayName('grok-4')).toBe('Grok 4');
    expect(modelDisplayName(undefined)).toBeUndefined();
  });
});

describe('<ContextIndicator>', () => {
  it('shows the model name to the left of the context percentage', () => {
    render(
      <ContextIndicator contextTokens={110_000} compacting={false} compactResult={null} model="claude-opus-4-6" compact={() => {}} />,
    );
    const label = screen.getByRole('button').textContent ?? '';
    // Name before percentage, in the same tappable indicator.
    expect(label.indexOf('Opus 4.6')).toBeGreaterThanOrEqual(0);
    expect(label.indexOf('Opus 4.6')).toBeLessThan(label.indexOf('% context'));
  });

  it('omits the name when no model is known yet', () => {
    render(<ContextIndicator contextTokens={50_000} compacting={false} compactResult={null} compact={() => {}} />);
    expect(screen.getByText(/% context/)).toBeTruthy();
  });
});
