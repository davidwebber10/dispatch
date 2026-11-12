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
  // temp folder): beside the state root, on the box's own disk, where the owner check of the file
  // routes holds. Set here because the file routes read it when they are imported.
  if (!process.env.DISPATCH_UPLOAD_DIR) process.env.DISPATCH_UPLOAD_DIR = path.join(path.dirname(cfg.stateDir), 'tmp', 'uploads');
  installSpawnGuard(cfg);
}
