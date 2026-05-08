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

/** Cached row count + schema sanity for `/health` and startup logs. */
export function getAirportCatalogStats() {
  const list = loadAirports();
  const row = list[0];
  return {
    count: list.length,
    hasScheduledServiceField: Boolean(
      row && Object.prototype.hasOwnProperty.call(row, "scheduledService"),
    ),
  };
}

/** Prefer bounding boxes around operational segments so cross-country traces do not pull in the entire US airport list. */
function pointsForAirportBBox(points) {
  const ops = points.filter((p) => {
    if (Number.isFinite(p.altFt) && p.altFt < 9500) return true;
    if (Number.isFinite(p.gsKt) && p.gsKt < 95) return true;
    return false;
  });
  return ops.length >= 100 ? ops : points;
}

/** Narrow airport candidates to a padded bounding box around the trace (critical for large US lists). */
export function filterAirportsByBBox(airports, points, padDeg) {
  const pts = pointsForAirportBBox(points);
  if (!pts?.length || !airports?.length) return airports;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of pts) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  const pad = Math.max(0.25, Number(padDeg) || 3);
  return airports.filter(
    (a) =>
      a.lat >= minLat - pad &&
      a.lat <= maxLat + pad &&
      a.lon >= minLon - pad &&
      a.lon <= maxLon + pad,
  );
}

/** Airports eligible for segment endpoint guessing (avoid picking random private strips). */
function endpointCandidatePool(airports) {
  const minorTypes = new Set(["small_airport", "seaplane_base"]);
  return airports.filter(
    (a) =>
      a.type === "large_airport" ||
      a.type === "medium_airport" ||
      (minorTypes.has(a.type) && a.scheduledService),
  );
}

/** Heuristic guesses for endpoints of a segmented flight trace. */
export function guessEndpoints(points) {
  const ap = loadAirports();
  if (!points.length || !ap.length) return { originGuess: null, destinationGuess: null };

  const candidates = filterAirportsByBBox(ap, points, 5);
  const pool = candidates.length ? candidates : ap;

  let poolEff = endpointCandidatePool(pool);
  if (!poolEff.length) {
    poolEff = pool.filter((a) => a.type === "large_airport" || a.type === "medium_airport");
  }
  if (!poolEff.length) {
    return { originGuess: null, destinationGuess: null };
  }

  const head = sliceHead(points);
  const tail = sliceTail(points);

  const o = nearestInSet(head, poolEff, 35);
  const d = nearestInSet(tail, poolEff, 35);

  return {
    originGuess: o,
    destinationGuess: d,
  };
}

function scanAirportHits(points, pool, cfg) {
  const seen = new Map();
  if (!pool.length || !points.length) return seen;

  const stride = cfg.stride ?? (points.length > 6000 ? 2 : 1);

  for (let i = 0; i < points.length; i += stride) {
    const pt = points[i];
    const alt = pt.altFt;
    const gs = pt.gsKt;
    if (cfg.skipFastHigh) {
      const { gsKt: maxGs, altFt: minAlt } = cfg.skipFastHigh;
      if (
        Number.isFinite(gs) &&
        Number.isFinite(alt) &&
        gs > maxGs &&
        alt > minAlt
      ) {
        continue;
      }
    }
    if (Number.isFinite(alt) && alt > (cfg.skipAltAbove ?? 11_000)) continue;

    let maxNm = cfg.baseNm ?? 10;
    if (Number.isFinite(alt) && alt > 6500) maxNm = cfg.midAltNm ?? maxNm;
    if (Number.isFinite(alt) && alt < 4500) maxNm = cfg.lowAltNm ?? maxNm;
    if (Number.isFinite(gs) && gs < 50) maxNm = Math.max(maxNm, cfg.lowGsNm ?? maxNm);

    const nearest = nearestForPoint(pt, pool, maxNm);
    if (!nearest) continue;
    const cur =
      seen.get(nearest.code) ||
      {
        code: nearest.code,
        name: nearest.name,
        lat: nearest.lat,
        lon: nearest.lon,
        airportType: nearest.airportType,
        hits: 0,
        firstIdx: i,
        distanceNm: nearest.distanceNm,
      };
    cur.hits += 1;
    cur.firstIdx = Math.min(cur.firstIdx, i);
    cur.distanceNm = Math.min(cur.distanceNm, nearest.distanceNm);
    seen.set(nearest.code, cur);
  }

  const minHits = cfg.minHits ?? 3;
  const maxDist = cfg.maxDistNm ?? 2.5;
  const ptLen = points.length;

  for (const code of [...seen.keys()]) {
    const v = seen.get(code);
    const ok =
      v.hits >= minHits ||
      v.distanceNm <= maxDist ||
      (cfg.allowSparse && ptLen < 40);
    if (!ok) seen.delete(code);
  }

  return seen;
}

/**
 * Detect airports along a trace using points straight from normalizeRawTraceToPoints (no kinematic smoothing).
 * Two-pass: national-field airports use inclusive radius; small strips need tight proximity / many hits.
 */
export function detectVisitedAirports(points, opts = {}) {
  const ap = loadAirports();
  if (!points.length || !ap.length) return [];

  const bboxPad = opts.bboxPadDeg ?? 3;
  const candidates = filterAirportsByBBox(ap, points, bboxPad);
  const pool = candidates.length ? candidates : ap;

  const majorPool = pool.filter((a) => a.type === "large_airport" || a.type === "medium_airport");

  const minorTypes = new Set(["small_airport", "seaplane_base"]);
  const scheduledMinorPool = pool.filter((a) => minorTypes.has(a.type) && a.scheduledService);
  const privateMinorPool = pool.filter((a) => minorTypes.has(a.type) && !a.scheduledService);

  const stride =
    Number(opts.sampleStride) || (points.length > 6000 ? 2 : 1);

  const majorHits = scanAirportHits(points, majorPool, {
    stride,
    baseNm: 11,
    midAltNm: 9,
    lowAltNm: 20,
    lowGsNm: 17,
    skipAltAbove: 11_000,
    minHits: Math.max(2, Number(opts.majorMinHits) || 2),
    maxDistNm: 4.2,
    allowSparse: true,
  });

  const scheduledMinorHits = scanAirportHits(points, scheduledMinorPool, {
    stride,
    baseNm: 6,
    midAltNm: 5,
    lowAltNm: 10,
    lowGsNm: 9,
    skipAltAbove: 9500,
    minHits: Math.max(10, Number(opts.scheduledMinorMinHits) || 10),
    maxDistNm: 1.25,
    allowSparse: false,
  });

  const privateMinorHits = scanAirportHits(points, privateMinorPool, {
    stride: 1,
    baseNm: 4,
    midAltNm: 3.5,
    lowAltNm: 6,
    lowGsNm: 6,
    skipFastHigh: { gsKt: 30, altFt: 1700 },
    skipAltAbove: 4800,
    minHits: Math.max(68, Number(opts.privateMinorMinHits) || 68),
    maxDistNm: 0.42,
    allowSparse: false,
  });

  const merged = new Map(majorHits);
  for (const [code, v] of scheduledMinorHits) {
    if (!merged.has(code)) merged.set(code, v);
  }
  for (const [code, v] of privateMinorHits) {
    if (!merged.has(code)) merged.set(code, v);
  }

  return Array.from(merged.values())
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
          airportType: a.type ?? "small_airport",
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
        airportType: a.type ?? "small_airport",
      };
    }
  }
  return best;
}
