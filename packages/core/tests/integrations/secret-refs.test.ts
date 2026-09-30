import { describe, it, expect } from 'vitest';
import { refsIn, findSecretRefs, substituteSecretRefs } from '../../src/integrations/secret-refs.js';

describe('refsIn', () => {
  it('finds each ${NAME} once, in order', () => {
    expect(refsIn('Bearer ${API_KEY} and ${_Other1} and ${API_KEY}')).toEqual(['API_KEY', '_Other1']);
  });

  it('ignores forms that are not a ${NAME} ref', () => {
    expect(refsIn('$API_KEY ${1BAD} ${} ${has-dash} {X} ${ SPACED }')).toEqual([]);
  });
});

describe('findSecretRefs', () => {
  it('reads remote header values and env values', () => {
    expect(findSecretRefs({
      type: 'remote',
      headers: { Authorization: 'Bearer ${LINEAR_TOKEN}', 'X-Team': 'eng' },
      env: { PROXY_PASS: '${PROXY_PASS}', PLAIN: 'x' },
    })).toEqual(['LINEAR_TOKEN', 'PROXY_PASS']);
  });

  it('reads stdio env values', () => {
    expect(findSecretRefs({ type: 'stdio', env: { GITHUB_TOKEN: '${GH_PAT}' } })).toEqual(['GH_PAT']);
  });

  it('never reads args, url, or header/env keys', () => {
    expect(findSecretRefs({
      type: 'remote',
      url: 'https://mcp.example.com/${IN_URL}',
      args: ['--token', '${IN_ARGS}'],
      headers: { '${IN_KEY}': 'plain' },
      env: { '${ENV_KEY}': 'plain' },
    })).toEqual([]);
  });

  it('ignores headers on a stdio integration (they are never sent)', () => {
    expect(findSecretRefs({ type: 'stdio', headers: { Authorization: '${UNUSED}' } })).toEqual([]);
  });

  it('dedupes a name used in both a header and an env value', () => {
    expect(findSecretRefs({ type: 'remote', headers: { A: '${TOKEN}' }, env: { B: '${TOKEN}' } })).toEqual(['TOKEN']);
  });
});

describe('substituteSecretRefs', () => {
  it('replaces each ref that has a value and leaves the rest literal', () => {
    expect(substituteSecretRefs('${A}:${B}:${A}', { A: 'fake-a' })).toBe('fake-a:${B}:fake-a');
  });
});
