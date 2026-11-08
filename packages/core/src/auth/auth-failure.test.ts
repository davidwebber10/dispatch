import { describe, it, expect } from 'vitest';
import { detectAuthFailure, authRequiredFrame } from './auth-failure.js';

describe('detectAuthFailure — a signed-out or expired login, not any error', () => {
  it('Claude Code', () => {
    expect(detectAuthFailure('Invalid API key · Please run /login')).toBe('The login is not valid');
    expect(detectAuthFailure('OAuth token has expired. Please obtain a new token or refresh your existing token.')).toBe('The login expired');
    expect(detectAuthFailure('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe('The login expired');
    expect(detectAuthFailure('Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toBe('The login was refused');
    expect(detectAuthFailure('Not logged in · Please run /login')).toBe('Not signed in');
  });

  it('Codex', () => {
    expect(detectAuthFailure('unexpected status 401 Unauthorized: {"error":{"message":"Your authentication token has been invalidated. Please try signing in again."}}')).toBe('The login was refused');
    expect(detectAuthFailure('Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.')).toBe('The login expired');
    expect(detectAuthFailure('Not logged in. Run codex login.')).toBe('Not signed in');
  });

  it('Grok and OpenCode (ACP)', () => {
    expect(detectAuthFailure('Authentication required')).toBe('Not signed in');
    expect(detectAuthFailure('Error: auth_required: run `grok login`')).toBe('Not signed in');
    expect(detectAuthFailure('ProviderAuthError: No API key found for provider openrouter')).toBe('Not signed in');
  });

  it('leaves other failures alone', () => {
    expect(detectAuthFailure('Process exited (1)')).toBeNull();
    expect(detectAuthFailure('API Error: 529 Overloaded')).toBeNull();
    expect(detectAuthFailure("You've hit your limit · resets 5pm")).toBeNull();
    expect(detectAuthFailure('The tool returned a 404 for /author/login-page')).toBeNull();
    expect(detectAuthFailure('')).toBeNull();
  });
});

describe('authRequiredFrame — the typed chat event', () => {
  it('an error result with an auth failure becomes system/auth_required with provider, account, reason', () => {
    expect(authRequiredFrame({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }, 'claude', 'work'))
      .toEqual({ type: 'system', subtype: 'auth_required', provider: 'claude', accountId: 'work', reason: 'The login is not valid', detail: 'Invalid API key · Please run /login' });
  });

  it('reads Claude errors[] and a spawn_error message too', () => {
    expect(authRequiredFrame({ type: 'result', is_error: true, errors: ['OAuth token has expired'] }, 'claude', undefined)?.reason).toBe('The login expired');
    expect(authRequiredFrame({ type: 'system', subtype: 'spawn_error', message: 'Error: Authentication required' }, 'grok', undefined)?.reason).toBe('Not signed in');
  });

  it('a successful result, a non-auth error, or another frame is null', () => {
    expect(authRequiredFrame({ type: 'result', is_error: false, result: 'Invalid API key' }, 'claude', 'cli')).toBeNull();
    expect(authRequiredFrame({ type: 'result', is_error: true, result: 'Process exited (1)' }, 'claude', 'cli')).toBeNull();
    expect(authRequiredFrame({ type: 'assistant', message: { content: [] } }, 'claude', 'cli')).toBeNull();
  });
});
