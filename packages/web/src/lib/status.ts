export type ProjectIndicator = 'needs_input' | 'working' | 'error' | 'idle';

/**
 * The project-header indicator, mirroring the backend's session rollup precedence
 * (needs_input > working > error > idle). Combines the backend's rolled-up
 * `session.status` with live per-tab statuses + a "tab spinning up" flag so the
 * header reacts instantly, before the next `session:status` broadcast lands.
 */
export function projectIndicator(
  sessionStatus: string | undefined,
  tabStatuses: string[],
  anyLoading: boolean,
): ProjectIndicator {
  const all = [sessionStatus ?? '', ...tabStatuses];
  if (all.includes('needs_input')) return 'needs_input';
  if (anyLoading || all.includes('working')) return 'working';
  if (all.includes('error')) return 'error';
  return 'idle';
}
