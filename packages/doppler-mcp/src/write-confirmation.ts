export interface WriteTarget {
  project?: string;
  config?: string;
  name: string;
}

/**
 * What doppler_set_secret / doppler_delete_secret return. Doppler answers a write with
 * every secret in the config, raw and computed values included, and whatever a tool
 * returns lands in the agent's transcript — so the tools drop that response and return
 * only which secret changed. It picks the target fields one by one, so a value riding
 * along on the argument never comes through.
 */
export function writeConfirmation(action: 'updated' | 'deleted', { project, config, name }: WriteTarget) {
  return { project, config, name, [action]: true };
}
