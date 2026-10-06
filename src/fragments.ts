// One source for the executor, tool schema, Agent instructions and UI.
type Fragment = {
  name: string; englishName: string; aliases: string[];
  attachment: number; bondType: 1;
  atoms: { label: string; hydrogen: number; point: [number, number] }[];
  bonds: { atoms: [number, number]; type: 1 | 4 }[];
};
const single = (label: string, hydrogen: number, aliases: string[]): Fragment => ({
  name: '', englishName: '', aliases, attachment: 0, bondType: 1,
  atoms: [{ label, hydrogen, point: [1, 0] }], bonds: [],
});
const h = Math.sqrt(3) / 2;
export const fragments: Record<string, Fragment> = {
  OH: single('O', 1, ['羟基', 'hydroxyl']),
  CH3: single('C', 3, ['甲基', 'methyl']),
  NH2: single('N', 2, ['氨基', 'amino']),
  F: single('F', 0, ['氟', '氟基', 'fluoro']),
  Cl: single('Cl', 0, ['氯', '氯基', 'chloro']),
  C2H5: { name: '乙基', englishName: 'ethyl', aliases: ['乙基', 'ethyl', 'Et', 'CH2CH3'], attachment: 0, bondType: 1,
    atoms: [{ label: 'C', hydrogen: 2, point: [1, 0] }, { label: 'C', hydrogen: 3, point: [1.5, h] }], bonds: [{ type: 1, atoms: [0, 1] }] },
  'n-propyl': { name: '正丙基', englishName: 'n-propyl', aliases: ['正丙基', '丙基', 'propyl', 'nPr', 'CH2CH2CH3', '三个碳的碳链', '三碳直链'], attachment: 0, bondType: 1,
    atoms: [{ label: 'C', hydrogen: 2, point: [1, 0] }, { label: 'C', hydrogen: 2, point: [1.5, h] }, { label: 'C', hydrogen: 3, point: [2.5, h] }],
    bonds: [{ type: 1, atoms: [0, 1] }, { type: 1, atoms: [1, 2] }] },
  'i-propyl': { name: '异丙基', englishName: 'isopropyl', aliases: ['异丙基', 'isopropyl', 'iPr', 'CH(CH3)2'], attachment: 0, bondType: 1,
    atoms: [{ label: 'C', hydrogen: 1, point: [1, 0] }, { label: 'C', hydrogen: 3, point: [1.5, h] }, { label: 'C', hydrogen: 3, point: [1.5, -h] }],
    bonds: [{ type: 1, atoms: [0, 1] }, { type: 1, atoms: [0, 2] }] },
  phenyl: { name: '苯基', englishName: 'phenyl', aliases: ['苯基', '苯环', 'phenyl', 'Ph', 'C6H5', 'benzene ring'], attachment: 0, bondType: 1,
    atoms: [[1,0],[1.5,h],[2.5,h],[3,0],[2.5,-h],[1.5,-h]].map((point,i) => ({label:'C',hydrogen:i===0?0:1,point:point as [number,number]})),
    bonds: Array.from({length:6},(_,i) => ({type:4 as const,atoms:[i,(i+1)%6] as [number,number]})) },
};
export const fragmentInputs = [...new Set(Object.entries(fragments).flatMap(([id, f]) => [id, ...f.aliases]))];
export const fragmentName = (id: string, language = 'zh-CN') => {
  const f = fragments[id]; return (language === 'en' ? f?.englishName : f?.name) || id;
};
export const fragmentList = (language = 'zh-CN') => Object.keys(fragments).map(id => fragmentName(id, language)).join(language === 'en' ? ', ' : '、');
export const fragmentCatalog = () => Object.entries(fragments).map(([id, f]) => ({
  id, name: fragmentName(id), englishName: fragmentName(id, 'en'), aliases: f.aliases, atomCount: f.atoms.length, attachment: f.attachment, bondType: f.bondType,
}));
export function resolveFragment(input: unknown) {
  if (typeof input !== 'string') return undefined;
  const value = input.trim();
  return Object.keys(fragments).find(id => id.toLowerCase() === value.toLowerCase() || fragments[id].aliases.some(a=>a.toLowerCase()===value.toLowerCase()));
}
