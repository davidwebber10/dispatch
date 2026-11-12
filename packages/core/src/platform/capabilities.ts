// packages/core/src/platform/capabilities.ts
// What this build ENFORCES, advertised to OS (heartbeat body, and the hosted bootstrap data) so OS can
// refuse to open an older image for a business person. One list; each value must be true of the
// code that ships it (capabilities.test.ts proves each claim against the tree):
//   base-path       served under DISPATCH_BASE_PATH (daemon/base-path.ts)
//   os-tools-proxy  the loopback company-tools proxy (os/tools-proxy.ts); the box token never reaches a thread.
//                   Since 2026-11-11 each company system is its own MCP server (os/os-servers.ts); the
//                   string stays because OS checks it.
//   profile         the business-profile route gate (profile/business-gate.ts), following the live
//                   profile from OS (os/profile.ts)
//   headless-v1     the API contract of docs/headless-api.md (a view in OS drives this daemon; GET /api/chats)
//   idle-info       the heartbeat reports `automations` and a real `lastActivityAt` (os/idle-info.ts), so OS
//                   may sleep an idle box without stepping on scheduled work
// Served by GET /api/host-context (OS reads it at provisioning) and sent on every heartbeat.
export const BOX_CAPABILITIES = ['base-path', 'os-tools-proxy', 'profile', 'headless-v1', 'idle-info'] as const;
export type BoxCapability = (typeof BOX_CAPABILITIES)[number];
