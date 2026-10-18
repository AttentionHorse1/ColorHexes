// Czysta geometria heksów, bez zależności od Owlbear SDK (łatwo ją przetestować).
//
// Współrzędne osiowe (q, r). Odległość między środkami sąsiednich komórek
// jest równa `dpi` (w Owlbear to wymiar "od krawędzi do krawędzi").
//
//  "pointy" - sąsiedzi leżą w poziomie (wierzchołek heksa skierowany w górę)
//  "flat"   - sąsiedzi leżą w pionie (płaska krawędź u góry)

export type Orientation = "pointy" | "flat";

export interface Point {
  x: number;
  y: number;
}

export interface Axial {
  q: number;
  r: number;
}

export type Segment = [Point, Point];

const SQRT3 = Math.sqrt(3);

/** Odległość w komórkach między dwiema komórkami. */
export function hexDistance(a: Axial, b: Axial = { q: 0, r: 0 }): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

/** Wszystkie komórki w odległości <= n od (0, 0). Liczba: 3n(n+1)+1. */
export function cellsWithin(n: number): Axial[] {
  const out: Axial[] = [];
  for (let q = -n; q <= n; q++) {
    const r1 = Math.max(-n, -q - n);
    const r2 = Math.min(n, -q + n);
    for (let r = r1; r <= r2; r++) {
      out.push({ q, r });
    }
  }
  return out;
}

/** Przesunięcie środka komórki względem środka komórki (0, 0), w pikselach. */
export function axialToOffset(a: Axial, orientation: Orientation, dpi: number): Point {
  if (orientation === "pointy") {
    return { x: dpi * (a.q + a.r / 2), y: dpi * (SQRT3 / 2) * a.r };
  }
  return { x: dpi * (SQRT3 / 2) * a.q, y: dpi * (a.r + a.q / 2) };
}

function axialRound(q: number, r: number): Axial {
  const x = q;
  const z = r;
  const y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) {
    rx = -ry - rz;
  } else if (dy > dz) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  // "|| 0" usuwa ujemne zero
  return { q: rx || 0, r: rz || 0 };
}

/** Odwrotność axialToOffset: piksele względem środka (0, 0) -> komórka. */
export function offsetToAxial(
  dx: number,
  dy: number,
  orientation: Orientation,
  dpi: number
): Axial {
  if (orientation === "pointy") {
    const r = dy / (dpi * (SQRT3 / 2));
    const q = dx / dpi - r / 2;
    return axialRound(q, r);
  }
  const q = dx / (dpi * (SQRT3 / 2));
  const r = dy / dpi - q / 2;
  return axialRound(q, r);
}

/** Sześć wierzchołków heksa o danym środku. */
export function hexCorners(center: Point, orientation: Orientation, dpi: number): Point[] {
  const size = dpi / SQRT3;
  const startDeg = orientation === "pointy" ? -30 : 0;
  const corners: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = ((60 * i + startDeg) * Math.PI) / 180;
    corners.push({
      x: center.x + size * Math.cos(angle),
      y: center.y + size * Math.sin(angle),
    });
  }
  return corners;
}

/** Środek komórki `a` dla siatki, której komórka (0, 0) ma środek w `origin`. */
export function cellCenter(
  origin: Point,
  a: Axial,
  orientation: Orientation,
  dpi: number
): Point {
  const o = axialToOffset(a, orientation, dpi);
  return { x: origin.x + o.x, y: origin.y + o.y };
}

/**
 * Wielokąty (po 6 wierzchołków) komórek w zasięgu n.
 * Przy `innerExclusive` >= 0 pomijane są komórki w odległości <= innerExclusive,
 * czyli zwracany jest sam pierścień (pasmo) między zasięgami.
 */
export function areaPolygons(
  origin: Point,
  n: number,
  orientation: Orientation,
  dpi: number,
  innerExclusive = -1
): Point[][] {
  return cellsWithin(n)
    .filter((a) => hexDistance(a) > innerExclusive)
    .map((a) => hexCorners(cellCenter(origin, a, orientation, dpi), orientation, dpi));
}

/** Komórki na zewnętrznym obwodzie, zamiast całego dysku O(n²). */
function rimCells(n: number): Axial[] {
  if (n === 0) return [{ q: 0, r: 0 }];
  const out: Axial[] = [];
  for (let q = -n; q <= n; q++) {
    const low = Math.max(-n, -q - n);
    const high = Math.min(n, -q + n);
    for (const r of new Set([low, high])) {
      if (hexDistance({ q, r }) === n) out.push({ q, r });
    }
    if (q === -n || q === n) {
      for (let r = low + 1; r < high; r++) out.push({ q, r });
    }
  }
  return out;
}

/**
 * Zewnętrzny obrys obszaru: krawędzie, które należą tylko do jednej komórki.
 * Dla n >= 0 jest ich 6 * (2n + 1).
 */
export function boundarySegments(
  origin: Point,
  n: number,
  orientation: Orientation,
  dpi: number
): Segment[] {
  const out: Segment[] = [];
  for (const cell of rimCells(n)) {
    const center = cellCenter(origin, cell, orientation, dpi);
    const poly = hexCorners(center, orientation, dpi);
    for (let i = 0; i < 6; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % 6];
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const neighbor = offsetToAxial(2 * midX - center.x - origin.x, 2 * midY - center.y - origin.y, orientation, dpi);
      if (hexDistance(neighbor) > n) out.push([a, b]);
    }
  }
  return out;
}
