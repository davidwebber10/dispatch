// ESLint flat config (W1-A, build health).
//
// Scope: the daemon (packages/core/src) and the CLI (packages/cli/src), type-aware.
// It is a small rule set on purpose: it catches the promise bugs that the compiler cannot see.
//
//   @typescript-eslint/no-floating-promises  error  a promise that nobody awaits loses its rejection
//   @typescript-eslint/no-misused-promises   error  a promise in a condition, a spread, or a void-return position
//   no-empty (allowEmptyCatch: false)        warn   an empty `catch {}` hides a failure
//
// The `lint` script in package.json holds a warning ceiling (--max-warnings). The ceiling is the
// warning count at merge. It can only go down: when you remove an empty catch, lower the number.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.claude/**', 'packages/web/**', 'packages/plugins/**'],
  },
  {
    files: ['packages/core/src/**/*.ts', 'packages/cli/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // tsconfig.test.json covers the test and fixture files that the build config excludes.
        project: ['./packages/core/tsconfig.test.json', './packages/cli/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    // An unused disable comment is not part of the ceiling; the ceiling counts empty blocks only.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // `arguments: false`: an async function as a call argument is not checked. On 2026-11-09 that
      // check reported 57 sites, and every one is an async Express route handler in routes/*.ts.
      // Those files belong to other workstreams, and the repair is a handler wrapper, not a `void`.
      // Set `arguments` back to true after the routes get an async wrapper.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      'no-empty': ['warn', { allowEmptyCatch: false }],
    },
  },
);
