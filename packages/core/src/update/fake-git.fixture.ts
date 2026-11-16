// Test support: a tiny fake git over a world of tags, main and ancestors. Excluded from the build (*.fixture.ts).
import type { GitExec } from './target.js';

export function release(tag: string, extra: Record<string, unknown> = {}) {
  return { tag_name: tag, html_url: `https://example.test/${tag}`, published_at: '2026-01-01T00:00:00Z', body: `notes ${tag}`, draft: false, prerelease: false, ...extra };
}

/** git failing the way `merge-base --is-ancestor` does when the answer is no. */
export function exit(status: number): Error { return Object.assign(new Error(`git exited ${status}`), { status }); }

export interface World {
  /** tag -> peeled commit on origin */
  tags?: Record<string, string>;
  /** Commits reachable from origin/main. */
  main?: string[];
  head?: string;
  /** child -> parents, for ancestor questions between non-main commits. */
  ancestors?: Record<string, string[]>;
  dirty?: string;
  branch?: string;
  fetchFails?: boolean;
  /** Existing local branches: name -> the full commit it points at. */
  existingBranches?: Record<string, string>;
}

/** A fake git over a tiny world. Every call is recorded. */
export function fakeGit(w: World): GitExec & { calls: string[][] } {
  const calls: string[][] = [];
  const main = new Set(w.main ?? []);
  const isAnc = (a: string, b: string): boolean => {
    if (a === b) return true;
    if (b === 'refs/remotes/origin/main') return main.has(a);
    return (w.ancestors?.[b] ?? []).some((p) => isAnc(a, p));
  };
  const fn = ((args: string[]) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === 'fetch') { if (w.fetchFails) throw exit(128); return ''; }
    if (cmd === 'ls-remote') {
      const lines: string[] = [];
      for (const [t, c] of Object.entries(w.tags ?? {})) lines.push(`tagobj-${t}\trefs/tags/${t}`, `${c}\trefs/tags/${t}^{}`);
      return lines.join('\n') + '\n';
    }
    if (cmd === 'merge-base') { if (isAnc(args[2], args[3])) return ''; throw exit(1); }
    if (cmd === 'rev-parse' && args[1] === 'HEAD') return `${w.head ?? 'head0'}\n`;
    if (cmd === 'rev-parse' && args[1] === '--abbrev-ref') return `${w.branch ?? 'main'}\n`;
    if (cmd === 'rev-parse' && args[1] === '--verify') { const hit = Object.entries(w.existingBranches ?? {}).find(([b]) => args[3] === `refs/heads/${b}`); if (hit) return `${hit[1]}\n`; throw exit(1); }
    if (cmd === 'status') return w.dirty ?? '';
    return '';
  }) as GitExec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

