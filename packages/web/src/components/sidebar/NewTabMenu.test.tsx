import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { NewTabMenu } from './NewTabMenu';

test('offers a Claude (structured) option', () => {
  render(<NewTabMenu sessionId="s1" onClose={() => {}} />);
  expect(screen.getByText(/Claude \(structured\)/i)).toBeInTheDocument();
});
