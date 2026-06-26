import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { SortableList } from './SortableList';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('renders every item via renderItem', () => {
  render(<SortableList items={items} onReorder={() => {}} renderItem={(it) => <div>row-{it.id}</div>} />);
  expect(screen.getByText('row-a')).toBeInTheDocument();
  expect(screen.getByText('row-b')).toBeInTheDocument();
  expect(screen.getByText('row-c')).toBeInTheDocument();
});

test('renders items when disabled (no drag wiring)', () => {
  render(<SortableList items={items} disabled onReorder={() => {}} renderItem={(it) => <div>row-{it.id}</div>} />);
  expect(screen.getByText('row-a')).toBeInTheDocument();
  expect(screen.getByText('row-c')).toBeInTheDocument();
});
