import { describe, expect, test } from 'vitest';
import { pickReachable } from './reachable-addresses.js';

type Iface = { address: string; family: string | number; internal: boolean };
const v4 = (address: string, internal = false): Iface => ({ address, family: 'IPv4', internal });
const ifaces = (o: Record<string, Iface[]>) => o as never;

describe('pickReachable', () => {
  test('a Tailscale IP that is on an interface (Tailscale is up) is offered, and so is the Wi-Fi IP', () => {
    const r = pickReachable({
      tsIps: ['100.96.27.65', 'fd7a:115c:a1e0::1'], wsl: false,
      ifaces: ifaces({ lo0: [v4('127.0.0.1', true)], en0: [v4('192.168.4.60')], utun4: [v4('100.96.27.65')] }),
    });
    expect(r).toEqual({ tailscale: ['100.96.27.65'], lan: ['192.168.4.60'] });
  });
  test('Tailscale installed but down: its IP is not on any interface, so it is not offered', () => {
    const r = pickReachable({ tsIps: ['100.96.27.65'], wsl: false, ifaces: ifaces({ en0: [v4('192.168.4.60')] }) });
    expect(r).toEqual({ tailscale: [], lan: ['192.168.4.60'] });
  });
  test('the Tailscale interface is not counted as a LAN address', () => {
    const r = pickReachable({ tsIps: [], wsl: false, ifaces: ifaces({ utun4: [v4('100.96.27.65')], en0: [v4('10.0.0.5')] }) });
    expect(r.lan).toEqual(['10.0.0.5']);
  });
  test('loopback, link-local and IPv6 are skipped', () => {
    const r = pickReachable({
      tsIps: [], wsl: false,
      ifaces: ifaces({ lo0: [v4('127.0.0.1', true)], en1: [v4('169.254.10.2'), { address: 'fe80::1', family: 'IPv6', internal: false }] }),
    });
    expect(r).toEqual({ tailscale: [], lan: [] });
  });
  test('192.168 comes before 10, which comes before the 172.16 range that Docker uses', () => {
    const r = pickReachable({
      tsIps: [], wsl: false,
      ifaces: ifaces({ docker0: [v4('172.17.0.1')], en2: [v4('10.1.1.4')], en0: [v4('192.168.4.60')] }),
    });
    expect(r.lan).toEqual(['192.168.4.60', '10.1.1.4', '172.17.0.1']);
  });
  test('node may report family as the number 4', () => {
    expect(pickReachable({ tsIps: [], wsl: false, ifaces: ifaces({ en0: [{ address: '192.168.4.60', family: 4, internal: false }] }) }).lan).toEqual(['192.168.4.60']);
  });
  test('on WSL the Tailscale IP comes from the Windows host so it needs no local interface, and the VM address is not offered', () => {
    const r = pickReachable({ tsIps: ['100.96.27.65'], wsl: true, ifaces: ifaces({ eth0: [v4('172.20.5.2')] }) });
    expect(r).toEqual({ tailscale: ['100.96.27.65'], lan: [] });
  });
});
