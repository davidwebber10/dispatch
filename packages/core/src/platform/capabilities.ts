// packages/core/src/platform/capabilities.ts
// What this build ENFORCES, advertised to OS (heartbeat body, and the hosted bootstrap data) so OS can
// refuse to open an older image for a business person. One list; each value must be true of the
// code that ships it (capabilities.test.ts proves each claim against the tree):
//   base-path       served under DISPATCH_BASE_PATH (daemon/base-path.ts)
//   os-tools-proxy  the loopback company-tools proxy (os/tools-proxy.ts); the box token never reaches a thread
//   profile         the business-profile route gate (profile/business-gate.ts), following the live
//                   profile from OS (os/profile.ts)
// Served by GET /api/host-context (OS reads it at provisioning) and sent on every heartbeat.
export const BOX_CAPABILITIES = ['base-path', 'os-tools-proxy', 'profile'] as const;
export type BoxCapability = (typeof BOX_CAPABILITIES)[number];
