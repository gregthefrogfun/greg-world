export const PLACES: Record<string, { x: number; z: number }> = {
  plaza: { x: 0.0, z: 1.12 }, green: { x: 0.0, z: -14.0 }, shed: { x: 13.3, z: -5.6 }, bench: { x: 12.32, z: 8.4 },
  edge: { x: 0.56, z: 17.36 }, home: { x: -13.3, z: 8.12 }, rock: { x: -12.32, z: -8.68 },
  mailbox: { x: -4.48, z: 15.12 }, cafe: { x: 14.7, z: -14.7 }, bakery: { x: 9.24, z: -17.64 },
  nook: { x: -17.64, z: 1.68 }, gym: { x: 8.4, z: 15.68 }, pitch: { x: 18.48, z: 2.24 }, stage: { x: -5.88, z: -6.72 },
  hill: { x: -17.92, z: -10.64 }, beach: { x: -10.36, z: 18.48 }, art: { x: -8.96, z: 12.32 }, flats: { x: 6.72, z: -9.24 },
  desk: { x: -17.64, z: 10.92 }, kitchen: { x: -8.96, z: 4.76 },
};
export const WALK_SPEED = 2.0;
export function pathBetween(a: string, b: string): number[][] {
  const A = PLACES[a] ?? PLACES.plaza, B = PLACES[b] ?? PLACES.plaza;
  if (a === b) return [[B.x, B.z]];
  const P = PLACES.plaza; const pts = [[A.x, A.z]];
  if (a !== "plaza" && b !== "plaza") pts.push([P.x, P.z]);
  pts.push([B.x, B.z]);
  return pts;
}
