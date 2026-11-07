/**
 * The starter plugin Settings → Plugins → "New plugin…" (and the plugin_scaffold tool, later)
 * writes. Plain ES module, no build step: it uses the app's React through `window.dispatch`,
 * which `activate` receives as `d`.
 */
export function pluginTemplate(id: string, name: string): { 'plugin.json': string; 'web.js': string; 'README.md': string } {
  const safeName = name.replace(/[\\'`]/g, '');
  const manifest = {
    id,
    name: safeName,
    version: '0.1.0',
    description: 'A new Dispatch plugin.',
    web: 'web.js',
    contributes: { views: [{ id: 'home', label: safeName, icon: 'puzzle' }] },
    permissions: [],
  };
  const web = `// ${safeName} — a Dispatch plugin. Edit this file; the app reloads it as you save.
// \`d\` is window.dispatch: the app's React (\`d.h\` is React.createElement), hooks, stores, api,
// ui primitives and styles, storage, and \`register\`. See docs/plugins.md in the Dispatch repo.
export default function activate(d) {
  const { h, ui } = d;

  function Home() {
    return h('div', { style: { padding: '22px 26px', maxWidth: 820, margin: '0 auto' } },
      h('h1', { style: { margin: 0, fontSize: 18, fontWeight: 700 } }, '${safeName}'),
      h('div', { style: { marginTop: 6, fontSize: 13, color: 'var(--color-text-secondary)' } },
        'Hello from ${safeName}. This screen comes from ~/.dispatch/plugins/${id}/web.js.'),
      h('div', { style: { marginTop: 16 } },
        h('button', { style: ui.styles.solidBtn(true), onClick: () => d.hint('The plugin says hello') }, 'Say hello')));
  }

  d.register('${id}', {
    views: [{ id: 'home', label: '${safeName}', icon: 'puzzle', Component: Home }],
  });
}
`;
  const readme = `# ${safeName}

A Dispatch plugin. The folder is the plugin:

- \`plugin.json\`: the manifest (id, name, version, what it contributes).
- \`web.js\`: the browser part. \`activate(d)\` runs when the app loads the plugin; \`d\` is the SDK.

What you can register from \`web.js\`:

- \`views\`: screens (the desktop rail, the phone's Plugins tab).
- \`settings\`: sections under Settings → PLUGINS.
- \`threadMenu\` and \`projectMenu\`: items in those menus.
- \`composerActions\`: buttons under the composer.
- \`slots\`: content in a named place of an existing screen.

Edit and save: the app reloads the plugin at once. Settings → Plugins shows its state and
any error. Add \`?safe\` to the app URL to load no plugins.

The SDK reference: docs/plugins.md in the Dispatch repository.
`;
  return { 'plugin.json': JSON.stringify(manifest, null, 2) + '\n', 'web.js': web, 'README.md': readme };
}
