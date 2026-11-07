/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 6): what a rule knows about
 * a plugin key's plugin. The registry installs the provider at boot; a null answer means the
 * plugin is unknown or disabled, and its key is refused.
 */
export interface PluginFacts { id: string; permissions: string[] }

let provider: (id: string) => PluginFacts | null = () => null;

export function configurePluginFacts(fn: (id: string) => PluginFacts | null): void { provider = fn; }
export function pluginFactsOf(id: string): PluginFacts | null { return provider(id); }
