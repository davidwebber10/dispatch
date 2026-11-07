/**
 * The plugin pieces the CLI shares with the daemon (`dispatch-server/plugins`): the manifest
 * parser, the marketplace URL rules, and the version order. No daemon state here.
 */
export { parseManifest, satisfiesDispatch, PLUGIN_ID_RE } from './manifest.js';
export { isMarketplaceUrl, slugOf } from './marketplaces.js';
export { compareVersions } from './installer.js';
