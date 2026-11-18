// packages/core/src/privsep/install.ts
// Imported FIRST by the daemon's entry file, for its side effects. On a box with privilege
// separation it loads the secrets out of the environment and installs the spawn guard before any
// other module can start a process or read a token. Everywhere else it does nothing.
import path from 'node:path';
import { privsep } from './config.js';
import { loadBoxSecrets } from './secrets.js';
import { installSpawnGuard } from './spawn-guard.js';

const cfg = privsep();
if (cfg) {
  loadBoxSecrets();
  // Uploads wait in a folder no workload can reach (the default is a predictable name in the shared
  // temp folder): the daemon's own scratch space on the box's disk, beside the agent run dir. Set
  // here because the file routes read the variable when they are imported.
  if (!process.env.DISPATCH_UPLOAD_DIR) process.env.DISPATCH_UPLOAD_DIR = path.join(path.dirname(cfg.agentRunDir), 'private', 'uploads');
  installSpawnGuard(cfg);
}
