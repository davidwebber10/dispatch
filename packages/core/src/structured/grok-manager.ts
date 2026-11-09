// packages/core/src/structured/grok-manager.ts
//
// The ACP manager moved to acp-manager.ts (it drives Grok AND OpenCode). This file stays as a
// re-export, so an importer of the old path and the old class name keeps working.
export { AcpStructuredSessionManager, GrokStructuredSessionManager } from './acp-manager.js';
