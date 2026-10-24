import type { SelectionSnapshot } from './molecule';

export const draftLimits = { operationsPerCall: 8, totalSteps: 32, requests: 64, atoms: 10000 };
export type DraftOperation = {
  operation: string; targetAtom?: string; targetBond?: string; atomRefs?: string[]; bondRefs?: string[];
  element?: string; fragment?: string; bondType?: number; reason?: string;
};
export type DraftStep = { edit: DraftOperation; nextAtomId: number; nextBondId: number };
export type DraftPlan = {
  operation: 'draft'; protocolVersion: 2; edits: DraftStep[]; reason: string;
  draftRevision: number; previewVersion: number;
};
export type DraftResult = {
  snapshot: SelectionSnapshot & { nextAtomId: number; nextBondId: number };
  patches: any[]; hydrogenPositions: string[]; createdAtoms: number[]; createdBonds: number[];
};
export const atomRef = (id: number) => `a:${id}`;
export const bondRef = (id: number) => `b:${id}`;
