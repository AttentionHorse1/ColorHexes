import assert from "node:assert/strict";
import {
  areaPolygons,
  axialToOffset,
  boundarySegments,
  cellsWithin,
  hexCorners,
  hexDistance,
  offsetToAxial,
  type Orientation,
} from "../src/hex.ts";

const DPI = 150;
const ORIENTATIONS: Orientation[] = ["pointy", "flat"];
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test("liczba komórek w zasięgu to 3n(n+1)+1", () => {
  for (let n = 0; n <= 40; n++) {
    assert.equal(cellsWithin(n).length, 3 * n * (n + 1) + 1);
  }
});

test("wszystkie komórki leżą w odległości <= n, a skrajne dokładnie n", () => {
  for (const n of [1, 2, 5, 12]) {
    const cells = cellsWithin(n);
    assert.ok(cells.every((c) => hexDistance(c) <= n));
    assert.equal(cells.filter((c) => hexDistance(c) === n).length, n === 0 ? 1 : 6 * n);
  }
});

test("sąsiednie komórki są oddalone o dokładnie dpi", () => {
  const neighbours = [
    { q: 1, r: 0 },
    { q: -1, r: 0 },
    { q: 0, r: 1 },
    { q: 0, r: -1 },
    { q: 1, r: -1 },
    { q: -1, r: 1 },
  ];
  for (const o of ORIENTATIONS) {
    for (const n of neighbours) {
      const p = axialToOffset(n, o, DPI);
      assert.ok(close(Math.hypot(p.x, p.y), DPI), `${o} ${JSON.stringify(n)}`);
    }
  }
});

test("pointy: sąsiedzi w poziomie, flat: sąsiedzi w pionie", () => {
  const p = axialToOffset({ q: 1, r: 0 }, "pointy", DPI);
  assert.ok(close(p.x, DPI) && close(p.y, 0));
  const f = axialToOffset({ q: 0, r: 1 }, "flat", DPI);
  assert.ok(close(f.x, 0) && close(f.y, DPI));
});

test("piksele -> komórka jest odwrotnością komórka -> piksele", () => {
  for (const o of ORIENTATIONS) {
    for (const c of cellsWithin(8)) {
      const p = axialToOffset(c, o, DPI);
      assert.deepEqual(offsetToAxial(p.x, p.y, o, DPI), c);
      // niewielkie przesunięcie nadal wskazuje tę samą komórkę
      assert.deepEqual(offsetToAxial(p.x + 5, p.y - 5, o, DPI), c);
    }
  }
});

test("wierzchołki heksa leżą w tej samej odległości od środka i sąsiadują krawędzią = size", () => {
  for (const o of ORIENTATIONS) {
    const corners = hexCorners({ x: 10, y: -20 }, o, DPI);
    const size = DPI / Math.sqrt(3);
    for (let i = 0; i < 6; i++) {
      assert.ok(close(Math.hypot(corners[i].x - 10, corners[i].y + 20), size));
      const next = corners[(i + 1) % 6];
      assert.ok(close(Math.hypot(next.x - corners[i].x, next.y - corners[i].y), size));
    }
  }
});

test("obrys ma 6(2n+1) krawędzi", () => {
  for (const o of ORIENTATIONS) {
    for (const n of [0, 1, 2, 3, 6, 12, 25]) {
      const segs = boundarySegments({ x: 333.3, y: 777.7 }, n, o, DPI);
      assert.equal(segs.length, 6 * (2 * n + 1), `${o} n=${n}`);
    }
  }
});

test("obrys tworzy zamkniętą pętlę (każdy wierzchołek ma dokładnie 2 krawędzie)", () => {
  const key = (p: { x: number; y: number }) =>
    `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
  for (const o of ORIENTATIONS) {
    const segs = boundarySegments({ x: 0, y: 0 }, 4, o, DPI);
    const degree = new Map<string, number>();
    for (const [a, b] of segs) {
      degree.set(key(a), (degree.get(key(a)) ?? 0) + 1);
      degree.set(key(b), (degree.get(key(b)) ?? 0) + 1);
    }
    assert.ok([...degree.values()].every((d) => d === 2), o);
  }
});

test("wielokąty obszaru: 6 wierzchołków na komórkę", () => {
  const polys = areaPolygons({ x: 0, y: 0 }, 3, "pointy", DPI);
  assert.equal(polys.length, 37);
  assert.ok(polys.every((p) => p.length === 6));
});

test("pierścień: komórki zewnętrznego zasięgu bez wewnętrznego, bez nakładania", () => {
  const origin = { x: 0, y: 0 };
  const inner = 3;
  const outer = 7;
  const band = areaPolygons(origin, outer, "pointy", DPI, inner);
  assert.equal(band.length, cellsWithin(outer).length - cellsWithin(inner).length);
  // żadna komórka pierścienia nie leży w zasięgu wewnętrznym
  const innerCenters = new Set(
    areaPolygons(origin, inner, "pointy", DPI).map((poly) => {
      const cx = poly.reduce((s, p) => s + p.x, 0) / 6;
      const cy = poly.reduce((s, p) => s + p.y, 0) / 6;
      return `${Math.round(cx)},${Math.round(cy)}`;
    })
  );
  for (const poly of band) {
    const cx = poly.reduce((s, p) => s + p.x, 0) / 6;
    const cy = poly.reduce((s, p) => s + p.y, 0) / 6;
    assert.ok(!innerCenters.has(`${Math.round(cx)},${Math.round(cy)}`));
  }
  // domyślnie (bez innerExclusive) zwraca pełny obszar
  assert.equal(areaPolygons(origin, outer, "flat", DPI).length, cellsWithin(outer).length);
});

console.log(`\n${passed} testów przeszło`);
