export interface ServerOption {
  label: string;
  origin: string;
}

// Each origin serves its own single-origin Dispatch app, so the switcher just
// navigates between them. Tailscale endpoints work when on the tailnet; the
// hosted origin works anywhere (behind Cloudflare Access).
export const SERVERS: ServerOption[] = [
  { label: 'MacBook', origin: 'http://davids-blackbook-pro.tailb919ab.ts.net:3456' },
  { label: 'Mac mini', origin: 'http://davids-mac-mini.tailb919ab.ts.net:3456' },
];

export function currentServer(origin: string = window.location.origin): ServerOption | undefined {
  return SERVERS.find((s) => s.origin === origin);
}

export function currentLabel(origin: string = window.location.origin): string {
  return currentServer(origin)?.label ?? 'Local';
}
