import { geoArea, geoContains } from "d3-geo";
import type { Feature, Geometry, Polygon, MultiPolygon, Position } from "geojson";

const EARTH_MILES = 3958.8;
const DEG = Math.PI / 180;

/**
 * d3-geo wants exterior rings clockwise on the sphere. Shapes written in GeoJSON order
 * (counter-clockwise) would otherwise render as "the whole globe minus this district".
 */
export function rewind<F extends Feature<Geometry, any>>(f: F): F {
  const g = f.geometry;
  const fixPoly = (rings: Position[][]): Position[][] => {
    const poly: Polygon = { type: "Polygon", coordinates: rings };
    return geoArea(poly) > 2 * Math.PI ? rings.map((r) => [...r].reverse()) : rings;
  };
  if (g.type === "Polygon") g.coordinates = fixPoly(g.coordinates);
  else if (g.type === "MultiPolygon") g.coordinates = g.coordinates.map(fixPoly);
  return f;
}

export function contains(f: Feature<Geometry, any>, lonlat: [number, number]): boolean {
  return geoContains(f, lonlat);
}

function rings(g: Geometry): Position[][] {
  if (g.type === "Polygon") return (g as Polygon).coordinates;
  if (g.type === "MultiPolygon") return (g as MultiPolygon).coordinates.flat();
  return [];
}

/**
 * Distance in miles from a point to the nearest edge of a district (0 if inside), plus the
 * nearest boundary point. Uses a local equirectangular plane around the point, which is
 * accurate to well under a percent at District Tap distances.
 */
export function distanceToFeature(f: Feature<Geometry, any>, p: [number, number]): { miles: number; nearest: [number, number] } {
  if (geoContains(f, p)) return { miles: 0, nearest: p };
  const [lon0, lat0] = p;
  const kx = Math.cos(lat0 * DEG) * EARTH_MILES * DEG;
  const ky = EARTH_MILES * DEG;
  const toXY = (q: Position) => {
    let dlon = q[0] - lon0;
    if (dlon > 180) dlon -= 360;
    if (dlon < -180) dlon += 360;
    return [dlon * kx, (q[1] - lat0) * ky];
  };
  let best = Infinity;
  let bestPt: [number, number] = p;
  for (const ring of rings(f.geometry)) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = toXY(ring[i]);
      const [bx, by] = toXY(ring[i + 1]);
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = Math.hypot(cx, cy);
      if (d < best) {
        best = d;
        bestPt = [lon0 + cx / kx, lat0 + cy / ky];
      }
    }
  }
  return { miles: best, nearest: bestPt };
}
