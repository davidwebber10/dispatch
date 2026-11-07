/** Types for the Coach's detectors module (the tests import it). */
import type { SignalsState } from './signals.mjs';
import type { CoachSettings } from './settings.mjs';

export type Measure = 'ambition' | 'delegation' | 'reuse' | 'judgment' | 'breadth';
export type DetectorId = 'repeated-prompt' | 'serial-independent' | 'idle-wait' | 'step-by-step' | 'no-plan-big-task' | 'fast-approve' | 'narrow-breadth' | 'plugin-fit';
export type TipType = 'prompt' | 'thinkBigger';
export interface Candidate { id: string; type: DetectorId; measure: Measure; tip: TipType; terminalId: string | null; projectId: string | null; evidence: Record<string, unknown> }
export const DETECTORS: Readonly<Record<DetectorId, { measure: Measure; tip: TipType }>>;
export function detect(state: SignalsState, settings: CoachSettings, now: Date | number, ctx?: { weakest?: Measure | null }): Candidate[];
export interface CandidatesDoc { items: (Candidate & { at: string })[]; seen: string[] }
export function proposeNew(doc: Partial<CandidatesDoc> | null, cands: Candidate[], now: Date | number | string): CandidatesDoc & { added: (Candidate & { at: string })[] };
