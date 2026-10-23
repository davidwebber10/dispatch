import { describe, expect, test } from 'vitest';
import { createTailscaleAccess, isTailscaleAddress } from './tailscale-access.js';

const STATUS = JSON.stringify({
  Self: { UserID: 7, DNSName: 'mac.tail1234.ts.net.', HostName: 'Mac', TailscaleIPs: ['100.64.0.9', 'fd7a:115c:a1e0::9'] },
});
const whois = (user: number, tags?: string[]) => JSON.stringify({ Node: { User: user, Tags: tags } });

function harness(opts: { whois?: string | Error; status?: string | Error } = {}) {
  let t = 1_000_000;
  const calls: string[][] = [];
  const exec = async (_bin: string, args: string[]) => {
    calls.push(args);
    const r = args[0] === 'status' ? (opts.status ?? STATUS) : (opts.whois ?? whois(7));
    if (r instanceof Error) throw r;
    return r;
  };
  return { ts: createTailscaleAccess({ exec, now: () => t }), calls, advance: (ms: number) => { t += ms; } };
}

describe('isTailscaleAddress', () => {
  test.each([
    ['100.64.0.1', true], ['100.127.255.255', true], ['::ffff:100.100.1.1', true], ['fd7a:115c:a1e0::1', true],
    ['100.128.0.1', false], ['100.63.255.255', false], ['192.168.1.5', false], ['127.0.0.1', false], [undefined, false],
  ])('%s -> %s', (a, want) => expect(isTailscaleAddress(a as string | undefined)).toBe(want));
});

describe('self', () => {
  test('names and ips are lowercase, without trailing dot', async () => {
    const { ts } = harness();
    expect(await ts.self()).toEqual({
      userId: 7, names: ['mac.tail1234.ts.net', 'mac'], ips: ['100.64.0.9', 'fd7a:115c:a1e0::9'],
    });
  });
  test('null when the CLI is missing', async () => {
    const { ts } = harness({ status: new Error('ENOENT') });
    expect(await ts.self()).toBeNull();
  });
});

describe('isOwnerPeer', () => {
  test('same user: true', async () => { expect(await harness().ts.isOwnerPeer('100.64.0.2')).toBe(true); });
  test('other user: false', async () => { expect(await harness({ whois: whois(8) }).ts.isOwnerPeer('100.64.0.2')).toBe(false); });
  test('tagged node: false', async () => {
    expect(await harness({ whois: whois(7, ['tag:server']) }).ts.isOwnerPeer('100.64.0.2')).toBe(false);
  });
  test('whois fails: false', async () => { expect(await harness({ whois: new Error('x') }).ts.isOwnerPeer('100.64.0.2')).toBe(false); });
  test('CLI missing: false', async () => { expect(await harness({ status: new Error('x') }).ts.isOwnerPeer('100.64.0.2')).toBe(false); });
  test('a non-tailscale address never runs the CLI', async () => {
    const h = harness();
    expect(await h.ts.isOwnerPeer('192.168.1.5')).toBe(false);
    expect(h.calls).toEqual([]);
  });
  test('allowed results are cached 5 minutes, refused 30 seconds', async () => {
    const ok = harness();
    await ok.ts.isOwnerPeer('100.64.0.2'); await ok.ts.isOwnerPeer('100.64.0.2');
    const n = ok.calls.filter((c) => c[0] === 'whois').length;
    expect(n).toBe(1);
    ok.advance(299_000); await ok.ts.isOwnerPeer('100.64.0.2');
    expect(ok.calls.filter((c) => c[0] === 'whois').length).toBe(1);
    ok.advance(2_000); await ok.ts.isOwnerPeer('100.64.0.2');
    expect(ok.calls.filter((c) => c[0] === 'whois').length).toBe(2);

    const no = harness({ whois: whois(8) });
    await no.ts.isOwnerPeer('100.64.0.2');
    no.advance(29_000); await no.ts.isOwnerPeer('100.64.0.2');
    expect(no.calls.filter((c) => c[0] === 'whois').length).toBe(1);
    no.advance(2_000); await no.ts.isOwnerPeer('100.64.0.2');
    expect(no.calls.filter((c) => c[0] === 'whois').length).toBe(2);
  });
});
