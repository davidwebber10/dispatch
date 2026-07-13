/**
 * Encodes a working directory into the Claude Code transcript folder name
 * (`~/.claude/projects/<encoded>`). The scheme mirrors Claude Code's own per
 * platform. The win32 scheme (replace `/ \ :` with `-`) is provisional and MUST
 * be confirmed against a real Windows `%USERPROFILE%\.claude\projects` listing
 * during bring-up; if it differs, only this function changes.
 */
export function encodeClaudeProjectDir(workDir: string, platform: 'darwin' | 'win32'): string {
  if (platform === 'win32') return workDir.replace(/[/\\:]/g, '-');
  return workDir.replace(/\//g, '-');
}
