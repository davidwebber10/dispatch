# @dispatchd/sdk

Type declarations for the Dispatch plugin SDK. A plugin is a folder with a `plugin.json` and a
`web.js` that exports `activate(d)`; `d` is the SDK the app hands the bundle. This package has no
runtime code: it types `d` so an editor and `tsc` can check a plugin.

```ts
import type { DispatchSdk } from '@dispatchd/sdk';

export default function activate(d: DispatchSdk) {
  const { h, hooks: { useState } } = d;
  function Screen() {
    const [n, setN] = useState(0);
    return h('button', { onClick: () => setN(n + 1) }, `Clicked ${n}`);
  }
  d.register(d.id, { views: [{ id: 'main', label: 'Counter', icon: 'star', Component: Screen }] });
}
```

With JSX, map `react` to the app's copy: `window.dispatch.React` (an esbuild or Vite alias), and
ship the built file as `web.js`. The full guide, the permissions, storage, the model part, workers,
marketplaces and publishing are in `docs/plugins.md` of the Dispatch repository.
