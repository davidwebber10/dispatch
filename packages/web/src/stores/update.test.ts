import { expect, test, beforeEach, vi } from 'vitest';

const getUpdateState = vi.fn();
vi.mock('../api/client', () => ({ api: { getUpdateState: () => getUpdateState() } }));

import { useUpdate } from './update';

beforeEach(() => {
  useUpdate.setState({ available: null, currentVersion: null, dismissedVersion: null, inProgress: false });
  getUpdateState.mockReset();
});

test('update:available populates the store from a WS event', () => {
  useUpdate.getState().applyEvent({ type: 'update:available', version: 'v1.2.0', url: 'https://x', publishedAt: '2026-01-01' });
  expect(useUpdate.getState().available).toEqual({ version: 'v1.2.0', url: 'https://x', publishedAt: '2026-01-01' });
});

test('update:in-progress sets inProgress; a fresh update:available clears it', () => {
  useUpdate.getState().applyEvent({ type: 'update:in-progress' });
  expect(useUpdate.getState().inProgress).toBe(true);
  useUpdate.getState().applyEvent({ type: 'update:available', version: 'v1.2.1' });
  expect(useUpdate.getState().inProgress).toBe(false);
});

test('dismiss records the currently-available version so the banner can hide it', () => {
  useUpdate.getState().applyEvent({ type: 'update:available', version: 'v1.2.0' });
  useUpdate.getState().dismiss();
  expect(useUpdate.getState().dismissedVersion).toBe('v1.2.0');
});

test('load() hydrates available + currentVersion from the late-joiner REST endpoint', async () => {
  getUpdateState.mockResolvedValue({ available: true, version: 'v1.3.0', url: 'https://x', publishedAt: '2026-02-01', currentVersion: '1.2.0' });
  await useUpdate.getState().load();
  expect(useUpdate.getState().available).toEqual({ version: 'v1.3.0', url: 'https://x', publishedAt: '2026-02-01' });
  expect(useUpdate.getState().currentVersion).toBe('1.2.0');
});

test('load() clears available when the endpoint reports none', async () => {
  useUpdate.setState({ available: { version: 'v1.2.0', url: null, publishedAt: null } });
  getUpdateState.mockResolvedValue({ available: false, version: null, url: null, publishedAt: null, currentVersion: '1.2.0' });
  await useUpdate.getState().load();
  expect(useUpdate.getState().available).toBeNull();
});
