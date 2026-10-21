import type http from 'http';
import net from 'net';

/**
 * Hold 127.0.0.1 and ::1 on the daemon's port too. The daemon listens on the wildcard
 * address; on macOS another process can still bind 127.0.0.1 on the same port without an
 * error, and from then on the browser's localhost requests reach that process instead of
 * Dispatch (an agent's dev server did this). Each guard hands its connections to the
 * daemon's HTTP server, so HTTP and WebSocket upgrades work through it unchanged.
 * Linux and WSL refuse the extra bind next to the wildcard one, and they refuse it to the
 * other process too, so there a failed guard is expected and quiet.
 */
export async function guardLoopback(server: http.Server, port: number, warn: (msg: string) => void = (m) => console.warn(m)): Promise<net.Server[]> {
  const guards: net.Server[] = [];
  for (const host of ['127.0.0.1', '::1']) {
    const guard = net.createServer((socket) => { server.emit('connection', socket); });
    try {
      await new Promise<void>((resolve, reject) => {
        guard.once('error', reject);
        guard.listen(port, host, () => { guard.off('error', reject); resolve(); });
      });
      guards.push(guard);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' && process.platform === 'darwin') {
        warn(`[dispatch] ${host === '::1' ? '[::1]' : host}:${port} is held by another process: browsers that open localhost:${port} reach it instead of Dispatch. Stop it (lsof -nP -iTCP:${port} -sTCP:LISTEN), then restart Dispatch.`);
      }
      // EADDRINUSE on Linux (the kernel already protects the port) or EADDRNOTAVAIL (no IPv6): nothing to do.
    }
  }
  return guards;
}
