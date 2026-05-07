/**
 * Hybrid simplification for mobile map polylines: Radmer + Douglas-Peucker-lite cap.
 */

function perpendicularDistanceKm(a, b, p) {
  const x0 = p.lon,
    y0 = p.lat,
    x1 = a.lon,
    y1 = a.lat,
    x2 = b.lon,
    y2 = b.lat;
  const A = x0 - x1;
  const B = y0 - y1;
  const C = x2 - x1;
  const D = y2 - y1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = lenSq !== 0 ? dot / lenSq : -1;
  if (param < 0) param = 0;
  else if (param > 1) param = 1;

  const xx = x1 + param * C;
  const yy = y1 + param * D;
  const dx = x0 - xx;
  const dy = y0 - yy;
  return Math.sqrt(dx * dx + dy * dy) * 111; // crude km-ish for small distances
}

function dpRammer(points, epsilonKm, indices) {
  if (indices.length <= 2) return indices;
  const first = indices[0];
  const last = indices[indices.length - 1];
  let maxDist = -1;
  let index = -1;

  const a = points[first],
    b = points[last];

  for (let i = 1; i < indices.length - 1; i++) {
    const d = perpendicularDistanceKm(a, b, points[indices[i]]);
    if (d > maxDist) {
      index = indices[i];
      maxDist = d;
    }
  }

  if (maxDist > epsilonKm && index !== -1) {
    const i1 = indices.indexOf(index);
    const left = dpRammer(points, epsilonKm, indices.slice(0, i1 + 1));
    const right = dpRammer(points, epsilonKm, indices.slice(i1));
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

export function simplifyTrack(points, opts = {}) {
  const epsilonKm = opts.epsilonKm ?? 0.75;
  const maxPoints = opts.maxPoints ?? 2000;

  if (!points.length) return points;

  // Uniform subsample cap first to keep DP cheap
  let pts = points;
  if (pts.length > maxPoints * 8) {
    const step = Math.ceil(pts.length / (maxPoints * 8));
    const reduced = [];
    for (let i = 0; i < pts.length; i += step) reduced.push(pts[i]);
    if (reduced[reduced.length - 1] !== pts[pts.length - 1])
      reduced.push(pts[pts.length - 1]);
    pts = reduced;
  }

  const indices = pts.map((_, i) => i);
  let outIdx = dpRammer(pts, epsilonKm, indices);

  while (outIdx.length > maxPoints && epsilonKm < 500) {
    outIdx = dpRammer(pts, epsilonKm * 1.75, indices);
    // If still failing, degrade by uniform thinning
    if (outIdx.length > maxPoints) {
      const step = Math.ceil(outIdx.length / maxPoints);
      const thin = [];
      for (let i = 0; i < outIdx.length; i += step) thin.push(outIdx[i]);
      if (thin[thin.length - 1] !== outIdx[outIdx.length - 1])
        thin.push(outIdx[outIdx.length - 1]);
      outIdx = thin;
      break;
    }
  }

  return outIdx.map((i) => pts[i]);
}
