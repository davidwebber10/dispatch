import fs from 'node:fs';
import path from 'node:path';

/**
 * `<dataDir>/daemon.pid` lets daemon controllers (WSL's restart()) find and signal the live
 * daemon without an OS service manager. Write it only once the port is bound: a duplicate
 * launch that loses the port race exits early and must not leave its own pid behind (#56).
 */
export function writeOwnPid(dataDir: string, pid: number = process.pid): void {
  fs.writeFileSync(path.join(dataDir, 'daemon.pid'), String(pid));
}

/** On shutdown, delete the file only while it still holds our pid: a newer daemon may own it. */
export function removeOwnPid(dataDir: string, pid: number = process.pid): void {
  const file = path.join(dataDir, 'daemon.pid');
  try {
    if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file);
  } catch { /* missing or unreadable: nothing of ours to remove */ }
}
