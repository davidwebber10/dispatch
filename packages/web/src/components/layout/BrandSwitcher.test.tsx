import { render, screen } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
import { BrandSwitcher } from './BrandSwitcher';
import { useUpdate } from '../../stores/update';

beforeEach(() => {
  useUpdate.setState({ currentVersion: '1.2.3' });
});

test('renders the daemon version after the Dispatch name', () => {
  render(<BrandSwitcher />);
  expect(screen.getByText('Dispatch')).toBeInTheDocument();
  expect(screen.getByText('v1.2.3')).toBeInTheDocument();
});

test('omits the version chip when the version is unknown', () => {
  useUpdate.setState({ currentVersion: null });
  render(<BrandSwitcher />);
  expect(screen.getByText('Dispatch')).toBeInTheDocument();
  expect(screen.queryByText(/^v/)).toBeNull();
});
