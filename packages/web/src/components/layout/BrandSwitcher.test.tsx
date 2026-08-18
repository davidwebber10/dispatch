import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
import { BrandSwitcher } from './BrandSwitcher';
import { useUpdate } from '../../stores/update';

beforeEach(() => {
  useUpdate.setState({ currentVersion: '1.2.3' });
});

// The switcher is now the rail's compact logo button: name + version live
// in the dropdown, so the tests open it first.
test('the dropdown shows the product name and daemon version', () => {
  render(<BrandSwitcher />);
  fireEvent.click(screen.getByTitle(/switch server/i));
  expect(screen.getByText('Dispatch')).toBeInTheDocument();
  expect(screen.getByText('v1.2.3')).toBeInTheDocument();
});

test('omits the version chip when the version is unknown', () => {
  useUpdate.setState({ currentVersion: null });
  render(<BrandSwitcher />);
  fireEvent.click(screen.getByTitle(/switch server/i));
  expect(screen.getByText('Dispatch')).toBeInTheDocument();
  expect(screen.queryByText(/^v\d/)).toBeNull();
});
