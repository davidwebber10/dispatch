/** Plain sentences for the system errors a route can hit. */
const FS_MESSAGES: Record<string, string> = {
  ENOENT: 'File or folder not found', EEXIST: 'A file or folder with that name already exists', ENOTDIR: 'Not a folder',
  EISDIR: 'That is a folder, not a file', EACCES: 'Permission denied', EPERM: 'Permission denied', ENOSPC: 'No space left on the disk',
  ENOTEMPTY: 'The folder is not empty', EMFILE: 'Too many open files', ENAMETOOLONG: 'The name is too long',
};

/**
 * The message a client may see for an error. A system error (ENOENT and the like) carries the server's file
 * paths and the temp folder in its text, so it becomes a plain sentence; the detail stays with the server.
 * Our own errors and multer's keep their text.
 */
export function clientMessage(err: any): string {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (/^E[A-Z0-9]+$/.test(code)) return FS_MESSAGES[code] ?? 'The operation failed';
  // A subprocess failure (a numeric exit code, a command line) or any other system error: its text names paths.
  if (err?.code !== undefined || err?.errno !== undefined || err?.syscall !== undefined || err?.cmd !== undefined) return 'The operation failed';
  return typeof err?.message === 'string' && err.message ? err.message : 'The request failed';
}
