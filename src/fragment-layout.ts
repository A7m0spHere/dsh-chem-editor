import { fragments } from './fragments';

const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segmentDistance(p: number[], a: number[], b: number[]) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return distance(p, [a[0] + t * dx, a[1] + t * dy]);
}
const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function crosses(a: number[], b: number[], c: number[], d: number[]) {
  return cross(a,b,c) * cross(a,b,d) < -1e-10 && cross(c,d,a) * cross(c,d,b) < -1e-10;
}
// Rotate/reflect the entire fragment. Never move existing atoms to make room.
export function fragmentPositions(data: any, molecule: string, anchor: number, fragment: string) {
  const m = data[molecule], p = m.atoms[anchor].location, template = fragments[fragment];
  if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) throw Object.assign(new Error('连接点缺少有效二维坐标。'), { code: 'invalid_patch' });
  const lengths = m.bonds.map((b: any) => distance(m.atoms[b.atoms[0]].location, m.atoms[b.atoms[1]].location)).filter((n: number) => n > 0.1);
  lengths.sort((a: number,b: number) => a-b); const length = lengths[Math.floor(lengths.length/2)] || 1;
  const molecules = Object.values(data).filter((v: any) => v?.type === 'molecule') as any[];
  const occupied = molecules.flatMap(v => v.atoms.map((a: any) => a.location));
  const oldBonds = molecules.flatMap(v => (v.bonds || []).map((b: any) => ({ a: v.atoms[b.atoms[0]].location, b: v.atoms[b.atoms[1]].location, incident: v === m && b.atoms.includes(anchor) })));
  let best = -Infinity, points: number[][] = [];
  for (const mirror of [1, -1]) for (let i = 0; i < 24; i++) {
    const t = Math.PI * 2 * i / 24, cos = Math.cos(t), sin = Math.sin(t);
    const candidate = template.atoms.map(({point:[x,y]}) => [p[0] + length * (x*cos - mirror*y*sin), p[1] + length * (x*sin + mirror*y*cos), p[2]]);
    const newBonds = [{ a: p, b: candidate[template.attachment], attachment: true }, ...template.bonds.map(b => ({ a: candidate[b.atoms[0]], b: candidate[b.atoms[1]], attachment: false }))];
    if (newBonds.some(b => oldBonds.some(c => crosses(b.a,b.b,c.a,c.b)))) continue;
    let gap = length * 2;
    for (const q of candidate) {
      for (const old of occupied) gap = Math.min(gap, distance(q, old));
      for (const b of oldBonds) gap = Math.min(gap, segmentDistance(q, b.a, b.b));
    }
    for (const b of newBonds) {
      for (const old of occupied) if (old !== p) gap = Math.min(gap, segmentDistance(old, b.a, b.b));
      // A shared endpoint is legitimate, but overlapping collinear bonds are not.
      for (const old of oldBonds) if (b.attachment && old.incident) {
        const other = old.a === p ? old.b : old.a;
        gap = Math.min(gap, segmentDistance(other, b.a, b.b));
      }
    }
    if (gap > best) { best = gap; points = candidate; }
  }
  if (best < length * 0.45) throw Object.assign(new Error('整个基团周围没有足够空间，请先调整布局，再重新选择连接点并提交。'), { code: 'crowded_attachment' });
  return points;
}
