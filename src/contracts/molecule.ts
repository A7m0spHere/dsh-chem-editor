// These contracts describe the existing v1 wire format, not planned v2 APIs.
export type KetAddress = { molecule: string; index: number };
export type AtomSnapshot = { id: number; element: string; charge?: number; isotope?: number; implicitHydrogens?: number };
export type BondSnapshot = { id: number; begin: number; end: number; type: number; stereo?: number };
export type Selection = { atoms: number[]; bonds: number[] };
export type MoleculeDocument = {
  schemaVersion: 1; documentId: string; revision: number; ket: string;
  title: string; language: 'zh-CN' | 'en'; lastAppliedAnnotationId?: string;
};
export type SelectionSnapshot = {
  documentId: string; revision: number; instanceId: string; ket: string; rawKet: string;
  atoms: AtomSnapshot[]; bonds: BondSnapshot[]; selection: Selection;
  attachmentAtom?: number; target?: AtomSnapshot; targetAddress?: KetAddress;
  atomAddresses?: Record<number, KetAddress>; bondAddresses?: Record<number, KetAddress>;
  aromaticBonds?: number[];
  nextAtomId?: number; nextBondId?: number;
};
export type AnnotationInstruction = { id: string; instruction: string; clarification?: string };
