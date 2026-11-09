import type { DispatchSdk as Declared, DispatchSdkV2 as DeclaredV2, ThreadInfo as DeclaredThread, ProjectInfo as DeclaredProject, ThreadStatusInfo as DeclaredStatus, Route as DeclaredRoute } from '@dispatchd/sdk';
import { buildSdk } from './sdk';
import { createPluginSdk, type ThreadInfo, type ProjectInfo, type ThreadStatusInfo } from './facade';
import type { Route } from '../lib/routes';

/**
 * A tsc-only check (no runtime, not a test): the SDK the app builds must satisfy the declarations
 * `@dispatchd/sdk` publishes. Adding a field to the real SDK without declaring it, or declaring a
 * method the real one lacks, fails the web build here. `sdk-declaration.test.ts` checks the member
 * names at run time.
 */
export const sdkMatchesDeclaration: Declared = buildSdk() as unknown as ReturnType<typeof buildSdk> satisfies Declared;
/** Version 2 (W3-F): the bound object against `DispatchSdkV2`. */
export const sdkV2MatchesDeclaration: DeclaredV2 = createPluginSdk('types-check') as unknown as ReturnType<typeof createPluginSdk> satisfies DeclaredV2;

/** The plain data types are the same in both places, in both directions. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const dataTypesMatch: [Same<ThreadInfo, DeclaredThread>, Same<ProjectInfo, DeclaredProject>, Same<ThreadStatusInfo, DeclaredStatus>, Same<Route, DeclaredRoute>] = [true, true, true, true];
