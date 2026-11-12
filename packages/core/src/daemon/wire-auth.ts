import type express from 'express';
import type Database from 'better-sqlite3';
import { createBoxGate } from '../auth/box-token.js';
import { createAccessGate, type AccessGate, type GateDeps } from '../auth/access-gate.js';
import { createTokenSource } from '../auth/access-token.js';
import { KeyRegistry } from '../auth/principals.js';
import { createKeyScope } from '../auth/key-scope.js';
import { createPrincipalMiddleware, createLoginKeyCheck } from '../auth/request-principal.js';
import { createNoCredentialStats, type NoCredentialStats } from '../auth/no-credential-stats.js';
import { createPairCodes, type PairCodes } from '../auth/pair-code.js';
import { createDeviceStore, type DeviceStore } from '../auth/devices.js';
import { reachableAddresses, type Reachable } from '../auth/reachable-addresses.js';
import { createAccessConfig } from '../auth/known-hosts.js';
import { createTailscaleAccess, type TailscaleAccess } from '../auth/tailscale-access.js';
import { platform } from '../platform/index.js';
import { privsep } from '../privsep/config.js';
import { isLocalPeer } from '../privsep/local-peer.js';

export interface AuthInputs {
  db: Database.Database;
  dataDir: string;
  /** `open`: every caller is the owner unless it sends a key (tests). `gate`: the request gate of the daemon. */
  mode: 'open' | 'gate';
  basePath: string;
  /** The shared secret of a hosted box (DISPATCH_BOX_TOKEN). With it, the box gate replaces the access gate. */
  boxToken: string | undefined;
  /** False: the gate never asks the tailscale CLI, and the address list is not offered. */
  network: boolean;
  keys?: KeyRegistry;
  clock?: () => number;
  cfAccess?: GateDeps['cfAccess'];
  tailscale?: TailscaleAccess;
}

export interface AuthServices {
  keys: KeyRegistry;
  noCredentialStats: NoCredentialStats;
  /** The request gate. Absent with `open` and on a hosted box. */
  accessGate?: AccessGate;
  /** One-time sign-in codes. Absent with `open`. */
  pairCodes?: PairCodes;
  /** Signed-in devices. Present only with the access gate. */
  devices?: DeviceStore;
  boxToken: string | undefined;
  /** Set with privilege separation: the owner credential counts only from a peer this accepts. */
  ownerPeerOk?: (remoteAddress: string | undefined) => boolean;
  /** Addresses a phone could use to reach this computer. Absent with `open` or without the network. */
  reachableAddresses?: () => Promise<Reachable>;
  /**
   * Add the auth middleware to the app, in the one order that is correct: the box gate, the sign-in
   * route, the access gate, then the principal check. Call it after the security headers and the
   * base-path strip, and before the body parser.
   */
  install(app: express.Express): void;
}

/** A tailscale stand-in for a build with no network: it knows no device. */
const NO_TAILSCALE: TailscaleAccess = { self: async () => null, isOwnerPeer: async () => false };

export function wireAuth(i: AuthInputs): AuthServices {
  const keys = i.keys ?? new KeyRegistry();
  const noCredentialStats = createNoCredentialStats({});
  if (i.mode === 'open') {
    return {
      keys, noCredentialStats, boxToken: undefined,
      install(app) { app.use(createPrincipalMiddleware({ registry: keys, scope: createKeyScope(i.db), via: 'test' })); },
    };
  }
  // The owner token file exists in both modes (a box admits the token as well as the box header).
  const boxToken = i.boxToken;
  // Privilege separation on a hosted box: the owner credential is taken only from a peer outside the
  // box, and the owner token file of a local install is neither written nor accepted (a workload
  // must have no way to learn or to present owner authority).
  const separated = !!boxToken && privsep() !== null;
  const ownerPeerOk = separated ? (addr: string | undefined) => !isLocalPeer(addr) : undefined;
  const getAccessToken: () => string | null = separated ? () => null : createTokenSource(i.dataDir);
  // The request gate (network exposure spec, section 7). On a hosted box the box token is
  // the credential and the router is the only caller, so the gate stays out of the way there.
  // One-time sign-in codes (Settings → Devices & access) that stand in for the token on the login route.
  const pairCodes = createPairCodes();
  // Signed-in devices: one row per browser or phone that signed in. Not on a hosted box, where
  // the router holds the box token and there is no sign-in page.
  const devices = boxToken ? undefined : createDeviceStore(i.db, { getToken: getAccessToken as () => string });
  const tailscaleAccess = i.tailscale ?? (i.network ? createTailscaleAccess() : NO_TAILSCALE);
  const accessGate = boxToken
    ? undefined
    : createAccessGate({
        getToken: getAccessToken as () => string,
        isGatewayPeer: (a) => platform.isHostGatewayPeer(a),
        config: createAccessConfig(i.dataDir),
        tailscale: tailscaleAccess,
        basePath: i.basePath,
        pairCodes,
        devices,
        ...(i.clock ? { now: i.clock } : {}),
        ...(i.cfAccess ? { cfAccess: i.cfAccess } : {}),
      });
  return {
    keys, noCredentialStats, accessGate, pairCodes, devices, boxToken, ownerPeerOk,
    reachableAddresses: i.network
      ? async () => {
          const me = await tailscaleAccess.self().catch(() => null);
          return reachableAddresses(me?.ips ?? [], platform.flavor === 'wsl');
        }
      : undefined,
    install(app) {
      if (boxToken) app.use(createBoxGate({ boxToken, registry: keys, getToken: getAccessToken, ownerPeerOk }));
      if (accessGate) {
        // Before the gate, which has no login exemption. A key never signs in (spec 6.4).
        app.post('/api/access/login', createLoginKeyCheck({ registry: keys }), ...accessGate.loginRoute);
        app.use(accessGate.middleware);
      }
      app.use(createPrincipalMiddleware({
        registry: keys, scope: createKeyScope(i.db), getToken: getAccessToken, boxToken, ownerPeerOk, stats: noCredentialStats, devices,
      }));
    },
  };
}
