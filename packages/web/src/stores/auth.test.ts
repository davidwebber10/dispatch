import { expect, test, beforeEach } from 'vitest';
import { useAuth } from './auth';

beforeEach(() => useAuth.setState({ requests: [] }));

test('auth:request adds a request; auth:updated replaces it by id', () => {
  useAuth.getState().applyEvent({ type: 'auth:request', request: { id: 'a1', url: 'u', status: 'pending' } });
  expect(useAuth.getState().requests[0].id).toBe('a1');
  useAuth.getState().applyEvent({ type: 'auth:updated', request: { id: 'a1', url: 'u', status: 'completed' } });
  expect(useAuth.getState().requests).toHaveLength(1);
  expect(useAuth.getState().requests[0].status).toBe('completed');
});
