import { describe, test, expect, afterEach } from 'vitest';
import { readPrivsep } from '../../src/privsep/config.js';
import { NEVER_INHERITED, boxSecret, loadBoxSecrets, parseSecrets, resetBoxSecretsForTest } from '../../src/privsep/secrets.js';

const base = { DISPATCH_PRIVSEP: '1', DISPATCH_AGENT_UID: '1000', DISPATCH_AGENT_GID: '1000', HOME: '/home/person', DISPATCH_STATE_DIR: '/var/lib/dispatch/state', DISPATCH_AGENT_RUN_DIR: '/run/dispatch/agent' };

describe('the privilege separation switch', () => {
  test('off without the variable: a local install is unchanged', () => {
    expect(readPrivsep({}, 501)).toBeNull();
    expect(readPrivsep({ DISPATCH_PRIVSEP: '0' }, 0)).toBeNull();
  });
  test('on: the three roots and the agent identity', () => {
    expect(readPrivsep(base, 0)).toEqual({
      agentUid: 1000, agentGid: 1000, stateDir: '/var/lib/dispatch/state', agentRunDir: '/run/dispatch/agent',
      agentDataDir: '/home/person/.dispatch', agentHome: '/home/person',
    });
  });
  test('on but not root: refuses to start (it could not change the user of a child)', () => {
    expect(() => readPrivsep(base, 1000)).toThrow(/does not run as root/);
  });
  test('the agent user is never root', () => {
    expect(() => readPrivsep({ ...base, DISPATCH_AGENT_UID: '0' }, 0)).toThrow(/must not be root/);
    expect(() => readPrivsep({ ...base, DISPATCH_AGENT_GID: '0' }, 0)).toThrow(/must not be root/);
  });
  test('a missing or relative path, or a state root inside the home, is refused', () => {
    expect(() => readPrivsep({ ...base, DISPATCH_STATE_DIR: 'state' }, 0)).toThrow(/absolute/);
    expect(() => readPrivsep({ ...base, DISPATCH_AGENT_UID: 'abc' }, 0)).toThrow(/not numbers/);
    expect(() => readPrivsep({ ...base, DISPATCH_STATE_DIR: '/home/person/.dispatch/state' }, 0)).toThrow(/outside the home/);
    expect(() => readPrivsep({ ...base, DISPATCH_AGENT_RUN_DIR: '/home/person/run' }, 0)).toThrow(/outside the home/);
  });
});

describe('the box secrets', () => {
  afterEach(() => resetBoxSecretsForTest());

  test('the pipe content is one JSON object; unknown names and empty values are dropped', () => {
    expect(parseSecrets('{"DISPATCH_BOX_TOKEN":"in","OS_BOX_TOKEN":"","X":"y"}')).toEqual({ DISPATCH_BOX_TOKEN: 'in' });
    expect(() => parseSecrets('not json')).toThrow();
    expect(() => parseSecrets('[]')).toThrow();
  });

  test('loading reads the descriptor once and leaves nothing in the environment', () => {
    const env: NodeJS.ProcessEnv = {
      DISPATCH_SECRETS_FD: '3', OS_BOX_TOKEN: 'stale-env-value', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/x',
      ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/x', PATH: '/usr/bin',
    };
    let reads = 0;
    loadBoxSecrets(env, (fd) => { reads++; expect(fd).toBe(3); return '{"DISPATCH_BOX_TOKEN":"inbound","OS_BOX_TOKEN":"outbound"}'; });
    expect(reads).toBe(1);
    for (const name of NEVER_INHERITED) expect(env[name]).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  test('a descriptor below 3 or not a number is refused', () => {
    expect(() => loadBoxSecrets({ DISPATCH_SECRETS_FD: '1' }, () => '{}')).toThrow(/descriptor/);
    expect(() => loadBoxSecrets({ DISPATCH_SECRETS_FD: '/etc/passwd' }, () => '{}')).toThrow(/descriptor/);
  });

  test('without a load, a reader gets the environment it was given, live', () => {
    const env: NodeJS.ProcessEnv = { OS_BOX_TOKEN: ' abc ' };
    expect(boxSecret('OS_BOX_TOKEN', env)).toBe('abc');
    env.OS_BOX_TOKEN = 'changed';
    expect(boxSecret('OS_BOX_TOKEN', env)).toBe('changed');
    expect(boxSecret('DISPATCH_BOX_TOKEN', env)).toBeUndefined();
  });

  test('the process environment is read live until the secrets are loaded (a local trial, the test suite)', () => {
    const before = process.env.OS_BOX_TOKEN;
    try {
      process.env.OS_BOX_TOKEN = 'from-env';
      expect(boxSecret('OS_BOX_TOKEN')).toBe('from-env');
    } finally {
      if (before === undefined) delete process.env.OS_BOX_TOKEN; else process.env.OS_BOX_TOKEN = before;
    }
  });
});
