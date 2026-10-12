import { describe, it, expect } from 'vitest';
import { broadKillDenial } from './broad-kill-guard.js';

const bash = (command: string) => broadKillDenial('Bash', { command });

describe('broadKillDenial — commands that signal processes by name or pattern', () => {
  // 2026-10-12: an agent's `pkill -f until` killed 14 Claude threads; each one's argv holds its prompt.
  it.each([
    'pkill -f until',
    'pkill -f until 2>/dev/null; cd /repo && python run.py',
    'cd /repo && pkill node',
    'pkill -x claude',
    'sudo pkill -9 -f "watch loop"',
    'killall node',
    'killall -9 python3',
    'kill $(pgrep -f until)',
    'kill -9 `pgrep node`',
    'pgrep -f worker | xargs kill',
    'pgrep -f worker | xargs -r kill -9',
    "ps aux | grep until | awk '{print $2}' | xargs kill",
    'kill $(ps -ef | grep loop | awk \'{print $2}\')',
    'kill $(pidof node)',
    'kill -9 -1',
    'kill -TERM 0',
    'if pgrep -f loop; then pkill -f loop; fi',
    'cd /repo\npkill -f loop',
    // Review round 1: ordinary forms the first version missed.
    'echo "$(pkill -f until)"',
    'kill "$(pgrep -f until)"',
    'echo "it\'s fine"; pkill -f until; echo "it\'s done"',
    '/usr/bin/pkill -f until',
    'env pkill -f until',
    'FOO=bar pkill -f until',
    '/usr/bin/time -p pkill -f until',
    'sudo -u "$USER" pkill -f until',
    'kill $(/usr/bin/pgrep -f until)',
    'kill -9 -1 2>/dev/null',
    'kill 0 # stop the process group',
    'kill 0 12345',
    'kill -s TERM -1',
    'xargs -I{} kill {} <<< $(pgrep -f until)',
    'pgrep -f until |\n  xargs kill',
    'pgrep -f until | xargs -I{} kill {}',
    'timeout 5 pkill -f until',
    '{ pkill -f until; }',
    // Review round 2.
    "printf '%s\\n' '<<EOF'\npkill -f node",
    'cat <<< EOF\npkill -f node',
    'cat <<EOF\n$(pkill -f node)\nEOF',
    'kill $(\npgrep -f node\n)',
    'pgrep -f node | xargs sudo kill',
  ])('blocks: %s', (cmd) => {
    const d = bash(cmd);
    expect(d).not.toBeNull();
    expect(d!.allow).toBe(false);
    expect(d!.message).toMatch(/by PID/);
  });

  it.each([
    'kill 12345',
    'kill -TERM 123 456',
    'kill -9 "$PID"',
    'kill $pid',
    'kill %1',
    'kill -1 1234',
    'kill -HUP 1234',
    'pgrep -fl loop',
    'kill $(cat /tmp/server.pid)',
    'lsof -ti :3996 | xargs kill',
    'echo "pkill is blocked here"',
    'grep -rn "killall" src/',
    'git log --grep="pkill"',
    'ls -la',
    'npm run skill-check',
    'python skillfull.py',
    // Review round 1: data and look-alikes the first version blocked.
    'echo "done\\"; pkill -f until"',
    "cat > cleanup-example.md <<'EOF'\npkill -f node\nEOF",
    'git ls-files docs/ps | xargs rg kill',
    'kill -- -12345',
    'kill -9 1234 2>/dev/null',
    // Review round 2.
    "cat <<'END-EXAMPLE'\npkill -f node\nEND-EXAMPLE",
    "cat <<'EOF'\n  EOF\npkill -f node\nEOF",
    'command -v /usr/bin/pkill',
  ])('allows: %s', (cmd) => {
    expect(bash(cmd)).toBeNull();
  });

  // The guard runs inside the daemon's message handling: odd input must never throw.
  it.each([
    'toString --help',
    'constructor --help',
    '__proto__ --help',
    '$('.repeat(10000) + 'echo ok' + ')'.repeat(10000),
    '$('.repeat(10000),
    'echo "unterminated',
    "echo 'unterminated",
    'kill $(',
    ')))',
  ])('never throws: %s', (cmd) => {
    expect(() => bash(cmd)).not.toThrow();
  });

  it('stays fast on a very long command', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `echo ${i} | grep ${i}`).join(' && ');
    const t0 = performance.now();
    expect(bash(long)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('only looks at the Bash tool', () => {
    expect(broadKillDenial('Write', { content: 'pkill -f until' })).toBeNull();
    expect(broadKillDenial('Bash', undefined)).toBeNull();
  });
});
