// Unified fragment contract: fixed templates and parsed dynamic fragments share
// one graph shape, one explicit attachment declaration and one budget.
export const fragmentLimits = { atoms: 12, rings: 1, ringAtoms: 8 };
export type FragmentConnectionBond = 1 | 2 | 3;
export type TemplateFragmentSpec = { kind: 'template'; id: string };
export type SmilesFragmentSpec = {
  kind: 'smiles';
  smiles: string;
  // Explicitly declared attachment inside the fragment: 0-based index in SMILES
  // atom order. The engine probe showed dummy atoms lose their label through
  // Indigo, so a usable attachment must never rely on engine round-trips.
  connection?: { atom: number; bondType?: FragmentConnectionBond };
};
export type FragmentSpec = TemplateFragmentSpec | SmilesFragmentSpec;
export type ParsedFragmentAtom = { label: string; charge: number; isotope: number; hydrogen: number; point: [number, number] };
export type ParsedFragmentBond = { atoms: [number, number]; type: 1 | 2 | 3 | 4 };
export type ParsedFragment = {
  atoms: ParsedFragmentAtom[];
  bonds: ParsedFragmentBond[];
  attachment: number;
  attachmentBondType: FragmentConnectionBond;
  source: string;
  contentHash: string;
};
