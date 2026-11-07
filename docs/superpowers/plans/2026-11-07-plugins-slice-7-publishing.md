# Plugins slice 7: publishing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin author publishes a local plugin to a marketplace with one command, the public marketplace repository exists with the examples in it, the SDK's types ship as a package, and the docs say how.

**Architecture:** `dispatch plugin publish <folder> --to <marketplace>` runs on the author's machine: it validates the manifest with the core parser, clones the marketplace into a temp folder with the author's own git credentials, refuses a version that is not newer than the one in the catalog, copies the folder to `plugins/<id>` (minus `node_modules` and the install record), commits on `plugin/<id>-<version>`, pushes, and opens a pull request through `gh` when it is installed (else prints the compare URL). `dispatch plugin list` and `dispatch skill list` read the daemon. `packages/sdk` is `@dispatchd/sdk`: hand-written type declarations of the SDK a bundle receives, checked against the real SDK by the web build. The public marketplace is the GitHub repository `polywood/dispatch-plugins`, seeded with `marketplace.json`, the two example plugins and one starter skill.

**Tech Stack:** as before; `gh` optional at runtime; npm publish of `@dispatchd/sdk` is the owner's step.

**Spec:** `docs/superpowers/specs/2026-11-07-plugins-design.md` sections 7.1 (the public repository, publishing is a pull request), 7.2 (last bullet), 2 (the SDK).

## Global Constraints

- Publishing never touches the author's local plugin (it stays local); it never pushes to `main` (a branch and a pull request only); it refuses a folder without a valid `plugin.json`, an id the marketplace has under another author's folder with a newer or equal version, and a marketplace URL that is not a marketplace URL (the core validator).
- The temp clone is removed after the run, success or failure.
- `gh` absent: the command prints the branch and the compare URL and exits 0.
- The SDK package has no runtime code: types and a README; `@dispatchd/sdk` is not published by the builder.
- The GitHub repository is created under the `polywood` organization as **private** first (the owner flips it to public when ready; a private repository is a working marketplace for the people who can read it); the builder pushes the seed only.

## Review Focus

1. A plugin folder that contains a symlink out of itself, or `node_modules`, must not land in the marketplace (Task 1 test "the copy skips node_modules, the install record and symlinks").
2. The version check: `1.10.0` publishes over `1.9.0`; `1.0.0` over `1.0.0` is refused (Task 1 test).
3. A failed push (no permission) leaves no temp clone behind and names git's line (Task 1 test).
4. The declared SDK types must match the real SDK: adding a field to `DispatchSdk` without the declaration must fail the web build (Task 2's tsc check).
5. The seed repository must install through the daemon end to end (Task 3 e2e against `polywood/dispatch-plugins` over https with the owner's credentials).

---

### Task 1: `dispatch plugin publish`, `dispatch plugin list`, `dispatch skill list`

**Files:**
- Create: `packages/cli/src/plugin-publish.ts` (`publishPlugin({ folder, marketplace, branch?, dryRun?, run, log, tmpDir }): Promise<{ id, version, branch, prUrl: string | null, compareUrl: string | null }>`; `run` is an injectable command runner (`(cmd, args, opts) => { code, stdout, stderr }`) so tests drive a bare repository and a fake `gh`), `packages/cli/tests/plugin-publish.test.ts`
- Modify: `packages/cli/src/index.ts` (`case 'plugin'`: `publish <folder> --to <url|slug> [--branch name] [--dry-run]`, `list`; `case 'skill'`: `list`; the help text), `packages/core/src/plugins/marketplaces.ts` (export `isMarketplaceUrl`, `slugOf` already exported) and `packages/core/src/index.ts` or the CLI's import path for `parseManifest`

- [ ] Tests: 'publishes a valid folder: a branch `plugin/<id>-<version>`, one commit with the folder under plugins/<id>, pushed to the marketplace; gh absent prints the compare URL'; 'the copy skips node_modules, the install record and symlinks'; 'a version not newer than the catalog's is refused with both versions named'; 'a folder without a plugin.json, or with a bad one, is refused with the parser's message'; 'a failed push leaves no temp clone and names git's line'; 'gh present: `gh pr create` runs with the title and body and its URL is returned'; '--to accepts a slug the daemon knows (read from ~/.dispatch/marketplaces.json)'.
- [ ] Implement; commit `feat(cli): dispatch plugin publish, plugin list, skill list`.

### Task 2: `@dispatchd/sdk` — the types package

**Files:**
- Create: `packages/sdk/package.json` (`@dispatchd/sdk`, version `1.0.0`, `types: index.d.ts`, `files`, `peerDependencies: react`), `packages/sdk/index.d.ts` (the `DispatchSdk` surface a bundle receives: `id`, `version`, `React`, `h`, `Fragment`, `hooks`, `zustand`, `stores` (opaque typed selectors), `actions`, `api` (the plugin-relevant subset, typed loosely as the client), `ui`, `icons`, `storage`, `settings`, `events`, `assist`, `fetch`, `worker`, `apiPath`, `hint`, `copyText`, `register`, `unregister`; the `Contributions` shape; the thread event types; `declare global { interface Window { dispatch?: DispatchSdk } }`), `packages/sdk/README.md` (how to use it with JSX: map `react` to `window.dispatch.React`; a bundle example; the event and storage API), `packages/web/src/plugins/sdk.types-check.ts` (a tsc-only file: `const check: import('../../../sdk').DispatchSdk = buildSdk();` and the reverse direction for the parts the package declares), `pnpm-workspace.yaml` (if packages/* is not already covered)
- [ ] Write; `pnpm build` (the web tsc catches a drift); commit `feat(sdk): @dispatchd/sdk type declarations (owner publishes)`.

### Task 3: the public marketplace repository and the seed

**Files:**
- Create (in a temp clone, pushed to GitHub): `README.md` (what the marketplace is, how to add it in Dispatch, how to publish), `marketplace.json` (`{ "name": "Dispatch plugins", "description": "The public marketplace for Dispatch plugins and skills." }`), `plugins/composer-favorites/` and `plugins/daily-rundown/` (from `docs/plugins/examples`, each with a `CHANGELOG.md`), `skills/tidy-first/` (`skill.json` + `SKILL.md`: list the folder and remove stray files you created before any change)
- Modify: `docs/plugins.md` (Publishing section with the command and the repository URL; the Marketplaces section names the public repository), `packages/web/src/components/settings/PluginsSection.tsx` (a one-line hint under MARKETPLACES naming the public repository URL with an Add button when it is not added yet)

- [ ] Create `polywood/dispatch-plugins` (private) with `gh repo create`, push the seed, record the URL in the ledger.
- [ ] E2E: add `https://github.com/polywood/dispatch-plugins.git` to an isolated daemon (the owner's gh credential helper serves the clone), browse, install `daily-rundown` and the skill, run the worker; `dispatch plugin publish docs/plugins/examples/composer-favorites --to <local bare repo> --dry-run` against a local marketplace (never a real PR from the e2e).
- [ ] Commit `docs(plugins): publishing; the public marketplace`.

### Task 4: release note draft, docs, suites

- [ ] `docs/releases/v3.28.0.md` draft (the plugin system across the seven slices, the Previews move and migration, the bare-name doc fix, what is off by default, the owner steps: flip the repository public, publish `@dispatchd/sdk`), not the version bump (the release is the owner's call).
- [ ] Full suites.
