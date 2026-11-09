# @dispatchd/sdk

Type declarations for the Dispatch plugin SDK. A plugin is a folder with a `plugin.json` and a
`web.js` that exports `activate(d)`; `d` is the SDK the app hands the bundle. This package has no
runtime code: it types `d` so an editor and `tsc` can check a plugin.

```ts
import type { DispatchSdkV2 } from '@dispatchd/sdk';

export default function activate(d: DispatchSdkV2) {
  const { h, hooks: { useState } } = d;
  function Screen() {
    const [n, setN] = useState(0);
    return h('button', { onClick: () => setN(n + 1) }, `Clicked ${n}`);
  }
  d.register({ views: [{ id: 'main', label: 'Counter', icon: 'star', Component: Screen }] });
}
```

`DispatchSdkV2` is what a plugin with `"sdk": 2` in `plugin.json` gets: the object is bound to the
plugin, so no call takes a plugin id. `DispatchSdk` is version 1 (no `sdk` field, or `"sdk": 1`).
Version 1 still works, but its `api` and `stores` are deprecated and go away in the next major
version of Dispatch. `docs/plugins.md` has the table that moves a plugin to version 2.

With JSX, map `react` to the app's copy (`d.React`; `window.dispatch.React` in a version 1 bundle) (an esbuild or Vite alias), and
ship the built file as `web.js`. The full guide, the permissions, storage, the model part, workers,
marketplaces and publishing are in `docs/plugins.md` of the Dispatch repository.
