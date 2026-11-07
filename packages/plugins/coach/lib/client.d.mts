/** Types for the Coach's daemon client (the tests import it). */
import type { AssistFn } from './judge.mjs';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeAssist(opts: { fetch: (url: string, init: any) => Promise<Response>; api: string; plugin: string; key: () => string; timeoutMs?: number }): AssistFn;
