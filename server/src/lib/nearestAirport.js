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

/** gs reported below threshold, or missing GS only when low-altitude near the pavement (common gap-fill behavior). */
function matchesLandingMotion(pt, cfg) {
  const maxGsKt = cfg.maxGsKt ?? 50;
  const gs = pt.gsKt;
  if (Number.isFinite(gs)) return gs < maxGsKt;

  if (!cfg.allowMissingGsNearGround) return false;

  const alt = pt.altFt;
  const ceiling = cfg.missingGsMaxAltFt ?? 2600;
  return Number.isFinite(alt) && alt <= ceiling;
}

function matchesRunwayRollProximity(pt, nearestDistNm, rb) {
  if (!rb) return false;
  const maxD = rb.maxDistNm ?? 0.42;
  const maxGs = rb.maxGsKt ?? 115;
  const maxAlt = rb.maxAltFt ?? 3600;
  if (nearestDistNm > maxD) return false;
  const gs = pt.gsKt;
  const alt = pt.altFt;
  if (!Number.isFinite(gs) || gs >= maxGs) return false;
  if (!Number.isFinite(alt) || alt > maxAlt) return false;
  return true;
}

/**
 * Landing / on-field visits:
 * - Taxi / parked: inside ~1 NM and gs below 50 kt (or missing gs near-ground), or
 * - Runway roll / energetic ops: inside ~0.4 NM, gs below rollout cap, low altitude (captures ADS-B points like ~90 kt on pavement).
 */
function scanLandingContacts(points, pool, cfg) {
  const seen = new Map();
  if (!pool.length || !points.length) return seen;

  const maxGsKt = cfg.maxGsKt ?? 50;
  const maxDistNm = cfg.maxDistNm ?? 1.0;
  const runwayBand =
    cfg.runwayBand === false
      ? null
      : {
          maxDistNm: cfg.runwayBand?.maxDistNm ?? 0.42,
          maxGsKt: cfg.runwayBand?.maxGsKt ?? 115,
          maxAltFt: cfg.runwayBand?.maxAltFt ?? 3600,
        };
  const outerSearchNm = Math.max(maxDistNm, runwayBand?.maxDistNm ?? 0);

  const baseMinHits = cfg.minHits ?? 3;
  const ptLen = points.length;
  const minHits = ptLen < 36 ? Math.min(2, baseMinHits) : baseMinHits;
  const burstMinHits = cfg.burstMinHits ?? 2;
  const burstMaxDistNm = cfg.burstMaxDistNm ?? 0.48;
  const maxAltFt = cfg.maxAltFt ?? 4800;

  const motionCfg = {
    maxGsKt,
    allowMissingGsNearGround: cfg.allowMissingGsNearGround !== false,
    missingGsMaxAltFt: cfg.missingGsMaxAltFt ?? 2600,
  };

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];

    const alt = pt.altFt;
    if (Number.isFinite(maxAltFt) && Number.isFinite(alt) && alt > maxAltFt) continue;

    const nearest = nearestForPoint(pt, pool, outerSearchNm);
    if (!nearest) continue;

    const slowOk =
      nearest.distanceNm <= maxDistNm && matchesLandingMotion(pt, motionCfg);
    const rollOk = matchesRunwayRollProximity(pt, nearest.distanceNm, runwayBand);

    if (!slowOk && !rollOk) continue;

    const cur =
      seen.get(nearest.code) ||
      {
        code: nearest.code,
        name: nearest.name,
        lat: nearest.lat,
        lon: nearest.lon,
        ...(nearest.faaIdent ? { faaIdent: nearest.faaIdent } : {}),
        airportType: nearest.airportType,
        hits: 0,
        firstIdx: i,
        distanceNm: nearest.distanceNm,
      };
    if (nearest.faaIdent && !cur.faaIdent) cur.faaIdent = nearest.faaIdent;
    cur.hits += 1;
    cur.firstIdx = Math.min(cur.firstIdx, i);
    cur.distanceNm = Math.min(cur.distanceNm, nearest.distanceNm);
    seen.set(nearest.code, cur);
  }

  for (const code of [...seen.keys()]) {
    const v = seen.get(code);
    const burstOk = v.hits >= burstMinHits && v.distanceNm <= burstMaxDistNm;
    if (v.hits < minHits && !burstOk) seen.delete(code);
  }

  return seen;
}

/**
 * Airports where the trace shows an on-field segment (slow taxi near reference point,
 * or tight runway-roll envelope at moderate groundspeed). Uses raw globe_history points.
 */
export function detectVisitedAirports(points, opts = {}) {
  const ap = loadAirports();
  if (!points.length || !ap.length) return [];

  const bboxPad = opts.bboxPadDeg ?? 3;
  const candidates = filterAirportsByBBox(ap, points, bboxPad);
  const pool = candidates.length ? candidates : ap;

  const seen = scanLandingContacts(points, pool, {
    maxGsKt: Number(opts.maxGsKt) || 50,
    maxDistNm:
      opts.maxDistNm !== undefined && opts.maxDistNm !== null
        ? Number(opts.maxDistNm)
        : 1.0,
    minHits: Number(opts.minLandingHits) || 3,
    maxAltFt:
      opts.maxAltFt !== undefined && opts.maxAltFt !== null
        ? Number(opts.maxAltFt)
        : 4800,
    allowMissingGsNearGround: opts.allowMissingGsNearGround !== false,
    missingGsMaxAltFt: Number(opts.missingGsMaxAltFt) || 2600,
    runwayBand:
      opts.runwayBand === false ? false : (opts.runwayBand && typeof opts.runwayBand === "object" ? opts.runwayBand : {}),
  });

  return Array.from(seen.values())
    .sort((a, b) => a.firstIdx - b.firstIdx)
    .map(({ code, name, lat, lon, distanceNm, faaIdent }) => ({
      code,
      name,
      lat,
      lon,
      distanceNm,
      ...(faaIdent ? { faaIdent } : {}),
    }));
}

/**
 * Endpoint-only “stop” evidence:
 * If the trace has poor ADS-B coverage at a field (no obvious taxi/roll samples),
 * we still try to pick up the airport from lowish altitude + modest groundspeed
 * near the *start/end* of each segmented flight.
 */
export function detectEndpointVisitedAirports(points, flights, opts = {}) {
  const ap = loadAirports();
  if (!points.length || !ap.length || !Array.isArray(flights) || !flights.length) return [];

  const bboxPad = opts.bboxPadDeg ?? 3;
  const candidates = filterAirportsByBBox(ap, points, bboxPad);
  const pool = candidates.length ? candidates : ap;

  const headTailWindow = Number(opts.headTailWindow) || 12;
  const maxDistNm = opts.maxDistNm ?? 2.6;
  const maxAltFt = opts.maxAltFt ?? 2500;
  // Primary rule: slower than taxi-ish speed.
  const maxGsKt = opts.maxGsKt ?? 50;
  // Relaxed ceiling for “poor ADS-B coverage” cases at stop boundaries.
  const gsRelaxKt = opts.gsRelaxKt ?? 130;
  // Only scan endpoints when there is a long gap indicating a stop.
  const dwellMinSec = Number(opts.dwellMinSec ?? 900);
  const minHits = Number(opts.minHits) || 2;

  const seen = new Map();

  const addHit = (nearest, pt) => {
    const code = nearest.code;
    const cur =
      seen.get(code) ||
      ({
        code: nearest.code,
        name: nearest.name ?? nearest.code,
        lat: nearest.lat,
        lon: nearest.lon,
        distanceNm: nearest.distanceNm,
        airportType: nearest.airportType,
        faaIdent: nearest.faaIdent,
        hits: 0,
        firstT: pt.t ?? 0,
      });

    cur.hits += 1;
    cur.firstT = Math.min(cur.firstT, pt.t ?? cur.firstT);
    cur.distanceNm = Math.min(cur.distanceNm, nearest.distanceNm);
    seen.set(code, cur);
  };

  for (let fi = 0; fi < flights.length; fi++) {
    const f = flights[fi];
    if (!f?.points?.length) continue;

    const pts = f.points;
    const n = pts.length;
    const win = Math.min(Math.max(1, headTailWindow), Math.floor(n / 2) || 1);

    // Stop boundary: a long gap between this flight and the previous/next.
    const includeHead =
      fi > 0 &&
      Number.isFinite(f.startTimeUnix) &&
      Number.isFinite(flights[fi - 1]?.endTimeUnix) &&
      f.startTimeUnix - flights[fi - 1].endTimeUnix >= dwellMinSec;

    const includeTail =
      fi + 1 < flights.length &&
      Number.isFinite(f.endTimeUnix) &&
      Number.isFinite(flights[fi + 1]?.startTimeUnix) &&
      flights[fi + 1].startTimeUnix - f.endTimeUnix >= dwellMinSec;
    if (!includeHead && !includeTail) continue;

    const head = includeHead ? pts.slice(0, win) : [];
    const tail = includeTail ? pts.slice(Math.max(0, n - win)) : [];
    const sample = head.concat(tail);

    for (const pt of sample) {
      const alt = pt.altFt;
      if (Number.isFinite(maxAltFt) && Number.isFinite(alt) && alt > maxAltFt) continue;

      const gs = pt.gsKt;
      if (Number.isFinite(gs)) {
        // When gs is available: accept gs < 50; otherwise allow up to `gsRelaxKt`
        // specifically because we are scanning stop boundaries.
        if (gs > maxGsKt && gs > gsRelaxKt) continue;
      } // missing gs: accept because altitude gate already passed

      const nearest = nearestForPoint(pt, pool, maxDistNm);
      if (!nearest) continue;
      addHit(nearest, pt);
    }
  }

  return Array.from(seen.values())
    .filter((v) => v.hits >= minHits)
    .sort((a, b) => a.firstT - b.firstT)
    .map(({ code, name, lat, lon, distanceNm, faaIdent }) => ({
      code,
      name,
      lat,
      lon,
      distanceNm,
      ...(faaIdent ? { faaIdent } : {}),
    }));
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
          ...(a.faaIdent ? { faaIdent: a.faaIdent } : {}),
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
        ...(a.faaIdent ? { faaIdent: a.faaIdent } : {}),
      };
    }
  }
  return best;
}
