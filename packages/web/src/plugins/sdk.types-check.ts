import type { DispatchSdk as Declared } from '@dispatchd/sdk';
import { buildSdk } from './sdk';

/**
 * A tsc-only check (no runtime, not a test): the SDK the app builds must satisfy the declarations
 * `@dispatchd/sdk` publishes. Adding a field to the real SDK without declaring it, or declaring a
 * method the real one lacks, fails the web build here.
 */
export const sdkMatchesDeclaration: Declared = buildSdk() as unknown as ReturnType<typeof buildSdk> satisfies Declared;
