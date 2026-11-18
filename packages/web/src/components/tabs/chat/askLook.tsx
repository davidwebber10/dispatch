import { usesOsLook } from '../../../lib/hostContext';

/**
 * The OS look of the Pretty thread view (2026-11-11): on a hosted box, or in the business preview,
 * the thread keeps the Pretty structure and behaviour exactly (assistant talk and tool rows inline,
 * in order, the same grouping, streaming, questions and cards) and only takes the OS type scale,
 * radii and input/button style. A local install keeps the Dispatch look unchanged.
 *
 * Read at render time (not once at import), so a test can switch it with setHostContextForTest.
 * The host context is fixed for the life of a page, so the value never changes under a mounted view.
 *
 * === AGENT NOTES ===
 * - Gate a STYLE with `askLook()` and keep the local branch byte-for-byte what it was. Do not fork
 *   structure on it: no collapsed work summaries, no different rows, no different indicators.
 * - The business wording of a tool row (a readable name, sans type) also needs `!can('tool-json')`;
 *   developers keep the raw name and the JSON expander.
 * - Colors are Dispatch tokens only (themes/polywoodOs.ts maps the OS variables onto them).
 */
export const askLook = (): boolean => usesOsLook();
