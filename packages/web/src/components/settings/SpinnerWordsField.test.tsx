import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SpinnerWordsField } from './SpinnerWordsField';

afterEach(cleanup);

test("Claude's own (the default) saves nothing; Only mine plus a built-in set saves those words", () => {
  const onSave = vi.fn();
  render(<SpinnerWordsField value={undefined} onSave={onSave} />);
  expect(screen.getByRole('radio', { name: "Claude's own" })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('radio', { name: 'Only mine' }));
  expect(onSave).not.toHaveBeenCalled(); // no words yet
  fireEvent.click(screen.getByRole('button', { name: 'Kitchen' }));
  expect(onSave).toHaveBeenLastCalledWith({ mode: 'replace', verbs: expect.arrayContaining(['Cooking', 'Simmering']) });
});

test('typed words save on blur; switching back to Claude\'s own clears them', () => {
  const onSave = vi.fn();
  render(<SpinnerWordsField value={{ mode: 'append', verbs: ['Shipping'] }} onSave={onSave} />);
  const box = screen.getByLabelText('Your working words');
  fireEvent.change(box, { target: { value: 'Shipping, Tinkering' } });
  fireEvent.blur(box);
  expect(onSave).toHaveBeenLastCalledWith({ mode: 'append', verbs: ['Shipping', 'Tinkering'] });
  fireEvent.click(screen.getByRole('radio', { name: "Claude's own" }));
  expect(onSave).toHaveBeenLastCalledWith(null);
});

test('your own sets: save the words under a name, use one, delete one', () => {
  const onSave = vi.fn();
  const onSaveSets = vi.fn();
  render(<SpinnerWordsField value={{ mode: 'replace', verbs: ['Mixing', 'Mastering'] }} onSave={onSave}
    sets={[{ name: 'Garden', words: ['Planting', 'Weeding'] }]} onSaveSets={onSaveSets} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save these words as a set' }));
  fireEvent.change(screen.getByLabelText('Set name'), { target: { value: 'Studio' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(onSaveSets).toHaveBeenLastCalledWith([{ name: 'Garden', words: ['Planting', 'Weeding'] }, { name: 'Studio', words: ['Mixing', 'Mastering'] }]);
  fireEvent.click(screen.getByRole('button', { name: 'Garden' }));
  expect(onSave).toHaveBeenLastCalledWith({ mode: 'replace', verbs: ['Planting', 'Weeding'] });
  fireEvent.click(screen.getByRole('button', { name: 'Delete set Garden' }));
  expect(onSaveSets).toHaveBeenLastCalledWith(null);
});
