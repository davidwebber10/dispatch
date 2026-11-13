import { afterEach, describe, expect, test } from 'vitest';
import {
  SharedBoxTokenError, boxTokenMode, describeBoxTokenMode, inboundBoxToken, osBoxToken, resetBoxSecretsForTests, takeBoxSecrets,
} from './box-secrets.js';
import { hostedTarget } from '../update/hosted.js';

afterEach(() => resetBoxSecretsForTests());

describe('the two box secrets', () => {
  test('a local install has neither', () => {
    expect(boxTokenMode({})).toBe('local');
    expect(boxTokenMode({ DISPATCH_BOX_TOKEN: 'a' })).toBe('local'); // an inbound token alone does not make a box hosted
  });

  test('two different values: split', () => {
    expect(boxTokenMode({ OS_BASE_URL: 'http://os', OS_BOX_TOKEN: 'out', DISPATCH_BOX_TOKEN: 'in' })).toBe('split');
  });

  test('one value in both roles stops the start, unless the switch says the platform still issues one', () => {
    const same = { OS_BASE_URL: 'http://os', OS_BOX_TOKEN: 'same-value', DISPATCH_BOX_TOKEN: 'same-value' };
    expect(() => boxTokenMode(same)).toThrow(SharedBoxTokenError);
    expect(() => boxTokenMode({ ...same, DISPATCH_BOX_TOKEN: ' same-value ' })).toThrow(SharedBoxTokenError);
    expect(() => boxTokenMode({ ...same, DISPATCH_ALLOW_SHARED_BOX_TOKEN: 'true' })).toThrow(SharedBoxTokenError);
    expect(boxTokenMode({ ...same, DISPATCH_ALLOW_SHARED_BOX_TOKEN: '1' })).toBe('shared-compat');
  });

  test('the refusal and the mode line never hold a value', () => {
    const env = { OS_BASE_URL: 'http://os', OS_BOX_TOKEN: 'tok-SECRET-value-1234567890', DISPATCH_BOX_TOKEN: 'tok-SECRET-value-1234567890' };
    let message = '';
    try { boxTokenMode(env); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('Refusing to start');
    expect(message).not.toContain('SECRET');
    for (const mode of ['local', 'split', 'shared-compat', 'no-inbound'] as const) expect(describeBoxTokenMode(mode)).not.toContain('SECRET');
  });

  test('hosted with no inbound token is named for what it is', () => {
    expect(boxTokenMode({ OS_BASE_URL: 'http://os', OS_BOX_TOKEN: 'out' })).toBe('no-inbound');
  });

  test('taking the secrets removes them from the environment and keeps each for its one job', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { OS_BASE_URL: 'http://os.example', OS_BOX_TOKEN: 'outbound-1', DISPATCH_BOX_TOKEN: 'inbound-1' });
      expect(takeBoxSecrets()).toBe('split');
      expect(process.env.OS_BOX_TOKEN).toBeUndefined();
      expect(process.env.DISPATCH_BOX_TOKEN).toBeUndefined();
      expect(inboundBoxToken()).toBe('inbound-1');
      expect(osBoxToken()).toBe('outbound-1');
      // "Hosted" still reads true: the test of it goes through the same reader.
      expect(hostedTarget()).toEqual({ baseUrl: 'http://os.example', boxToken: 'outbound-1' });
      // Another env object (a test build's) never sees what the process took.
      expect(inboundBoxToken({})).toBeUndefined();
      expect(osBoxToken({ OS_BOX_TOKEN: 'x' })).toBe('x');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
