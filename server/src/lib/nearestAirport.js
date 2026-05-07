import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

let airportsCache;

function loadAirports() {
  if (airportsCache) return airportsCache;
  const fp = path.join(__dirname, "..", "..", "data", "airports_us_basic.json");
  try {
    const raw = fs.readFileSync(fp, "utf8");
    airportsCache = JSON.parse(raw);
  } catch {
    airportsCache = [];
  }
  return airportsCache;
}

/** Heuristic guesses for endpoints of a segmented flight trace. */
export function guessEndpoints(points) {
  const ap = loadAirports();
  if (!points.length || !ap.length)
    return { originGuess: null, destinationGuess: null };

  const head = sliceHead(points);
  const tail = sliceTail(points);

  const o = nearestInSet(head, ap, 250);
  const d = nearestInSet(tail, ap, 250);

  return {
    originGuess: o,
    destinationGuess: d,
  };
}

/**
 * Detect airports touched across a full day path by looking for repeated
 * nearest-airport matches along the route (not just segment endpoints).
 */
export function detectVisitedAirports(points, opts = {}) {
  const ap = loadAirports();
  if (!points.length || !ap.length) return [];

  const maxNm = Math.max(0.8, Number(opts.maxNm) || 3.2);
  const minHits = Math.max(1, Number(opts.minHits) || 2);
  const stride = Math.max(1, Number(opts.sampleStride) || 2);

  const seen = new Map();
  for (let i = 0; i < points.length; i += stride) {
    const pt = points[i];
    const nearest = nearestForPoint(pt, ap, maxNm);
    if (!nearest) continue;
    const cur = seen.get(nearest.code) || { ...nearest, hits: 0, firstIdx: i, distanceNm: nearest.distanceNm };
    cur.hits += 1;
    cur.firstIdx = Math.min(cur.firstIdx, i);
    cur.distanceNm = Math.min(cur.distanceNm, nearest.distanceNm);
    seen.set(nearest.code, cur);
  }

  return Array.from(seen.values())
    .filter((v) => v.hits >= minHits || points.length < 24)
    .sort((a, b) => a.firstIdx - b.firstIdx)
    .map(({ code, name, lat, lon, distanceNm }) => ({ code, name, lat, lon, distanceNm }));
}

function sliceHead(points, max = 8) {
  return points.slice(0, Math.min(max, points.length));
}

function sliceTail(points, max = 8) {
  const n = points.length;
  return points.slice(Math.max(0, n - Math.min(max, n)));
}

function nearestInSet(samplePts, airports, maxNm) {
  let best = null;

  const candidates = airports;
  for (const pt of samplePts) {
    for (const a of candidates) {
      const dist = haversineNm(pt.lat, pt.lon, a.lat, a.lon);
      if (dist <= maxNm && (!best || dist < best.distanceNm)) {
        best = {
          code: a.code,
          name: a.name ?? a.code,
          lat: a.lat,
          lon: a.lon,
          distanceNm: dist,
        };
      }
    }
  }
  return best;
}

function nearestForPoint(pt, airports, maxNm) {
  let best = null;
  for (const a of airports) {
    const dist = haversineNm(pt.lat, pt.lon, a.lat, a.lon);
    if (dist <= maxNm && (!best || dist < best.distanceNm)) {
      best = {
        code: a.code,
        name: a.name ?? a.code,
        lat: a.lat,
        lon: a.lon,
        distanceNm: dist,
      };
    }
  }
  return best;
}
