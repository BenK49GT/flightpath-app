import path from "node:path";
import { fileURLToPath } from "node:url";

import { eachUtcDayInclusive, parseYmdUtc, ymdFromUtcMs } from "./lib/dates.js";
import { makeFlightId, parseFlightId } from "./lib/flightId.js";
import { getAirportCatalogStats, guessEndpoints } from "./lib/nearestAirport.js";
import { lookupAircraft, normalizeReg } from "./lib/regLookup.js";
import { segmentFlights } from "./lib/segment.js";
import { simplifyTrack } from "./lib/simplify.js";
import { loadPointsForRange } from "./lib/traceStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MAX_RANGE_DAYS = Number(process.env.MAX_RANGE_DAYS || 31);
export const traceBase = path.join(__dirname, "..");

export function assertRange(from, to) {
  const a = parseYmdUtc(from);
  const b = parseYmdUtc(to);
  if (a === null || b === null) {
    const err = new Error("Expected from/to as YYYY-MM-DD");
    err.code = "INVALID_DATE_RANGE";
    throw err;
  }
  if (b < a) {
    const err = new Error("`to` must be on or after `from`");
    err.code = "INVALID_DATE_RANGE";
    throw err;
  }

  const days = eachUtcDayInclusive(from, to).length;
  if (days > MAX_RANGE_DAYS) {
    const err = new Error(`Requested range spans ${days} days; maximum is ${MAX_RANGE_DAYS}`);
    err.code = "RANGE_TOO_LARGE";
    throw err;
  }
  return { from, to, dayStartsUtcMs: eachUtcDayInclusive(from, to), days };
}

export async function buildFlights(registration, from, to) {
  const ac = lookupAircraft(registration);
  const range = assertRange(from, to);

  const { points, notes } = await loadPointsForRange({
    traceBase,
    icao24: ac.icao24,
    dayStartsUtcMs: range.dayStartsUtcMs,
  });

  const rawSegs = segmentFlights(points, {});

  const flights = [];

  let rangeStartUnix = Number.MAX_SAFE_INTEGER;
  let rangeEndUnix = 0;
  for (const ms of range.dayStartsUtcMs) {
    const start = ms / 1000;
    const end = start + 86400 - 1;
    rangeStartUnix = Math.min(rangeStartUnix, start);
    rangeEndUnix = Math.max(rangeEndUnix, end);
  }

  for (const sf of rawSegs) {
    const overlap =
      sf.endTimeUnix >= rangeStartUnix && sf.startTimeUnix <= rangeEndUnix;
    if (!overlap) continue;
    const { originGuess, destinationGuess } = guessEndpoints(sf.points);
    flights.push({
      id: makeFlightId(ac.icao24, sf.startTimeUnix),
      icao24: ac.icao24,
      registration: ac.registration,
      startTimeUnix: sf.startTimeUnix,
      endTimeUnix: sf.endTimeUnix,
      durationSec: sf.durationSec,
      pointCount: sf.pointCount,
      bbox: sf.bbox,
      originGuess,
      destinationGuess,
    });
  }

  flights.sort((a, b) => b.startTimeUnix - a.startTimeUnix);

  const daysWithData = new Set();
  for (const p of points) {
    daysWithData.add(ymdFromUtcMs(p.t * 1000));
  }

  return {
    ac,
    from,
    to,
    flights,
    traceMeta: {
      daysRequested: range.days,
      daysWithData: daysWithData.size,
      pointCountTotal: points.length,
      ingestNotes: notes,
    },
  };
}

export async function flightTrack(ac, flightId, from, to, maxPoints, epsilonDeg) {
  assertRange(from, to);
  const parsed = parseFlightId(flightId);
  if (!parsed || parsed.icao24 !== ac.icao24) {
    const err = new Error("Flight ID does not match aircraft ICAO record");
    err.code = "FLIGHT_NOT_FOUND";
    throw err;
  }

  const range = assertRange(from, to);
  const { points } = await loadPointsForRange({
    traceBase,
    icao24: ac.icao24,
    dayStartsUtcMs: range.dayStartsUtcMs,
  });

  const segs = segmentFlights(points, {});
  const seg = segs.find((s) => s.startTimeUnix === parsed.startTimeUnix);
  if (!seg) {
    const err = new Error("Flight not found for this registration and date window");
    err.code = "FLIGHT_NOT_FOUND";
    throw err;
  }

  const epsilonKm = Math.max(Number(epsilonDeg) || 0.01, 0.005) * 111;
  const simp = simplifyTrack(seg.points, {
    epsilonKm,
    maxPoints: Math.min(Number(maxPoints) || 2000, 10000),
  });

  return {
    flightId,
    registration: ac.registration,
    icao24: ac.icao24,
    points: simp.map((p) => ({
      t: p.t,
      lat: p.lat,
      lon: p.lon,
      altFt: p.altFt,
      gsKt: p.gsKt,
      trackDeg: p.trackDeg,
    })),
    simplification: {
      maxPoints: Number(maxPoints) || 2000,
      epsilonDeg: Number(epsilonDeg) || 0.02,
    },
  };
}

export async function handleHealth() {
  const cat = getAirportCatalogStats();
  return {
    status: 200,
    body: {
      ok: true,
      service: "flightpath-api",
      airportsCatalogCount: cat.count,
      airportsCatalogScheduledField: cat.hasScheduledServiceField,
      gitCommit:
        process.env.RENDER_GIT_COMMIT ||
        process.env.REVISION ||
        process.env.K_REVISION ||
        null,
    },
  };
}

export async function handleSummary(reg, from, to) {
  try {
    if (!from || !to) {
      return {
        status: 400,
        body: { error: "BAD_REQUEST", message: "Query params `from` and `to` (YYYY-MM-DD) are required" },
      };
    }
    const registration = normalizeReg(reg);
    const info = await buildFlights(registration, String(from), String(to));

    return {
      status: 200,
      body: {
        registration: info.ac.registration,
        icao24: info.ac.icao24,
        aircraftType: info.ac.aircraftType,
        manufacturer: info.ac.manufacturer,
        requestedRangeUtc: { from: info.from, to: info.to },
        traceCoverage: {
          daysWithData: info.traceMeta.daysWithData,
          daysRequested: info.traceMeta.daysRequested,
          notes:
            info.traceMeta.pointCountTotal === 0
              ? [
                  "No local trace archives found for those days. Seed demo data (`npm run seed-demo`) or run `npm run ingest` with readsb/trace JSON dumps.",
                ]
              : [],
        },
        sources: [
          ...info.ac.sources.map((s) => ({
            name: s.name,
            role: s.role,
          })),
          {
            name: "flightpath_local_trace_archive",
            role: "position_history_processed_by_you",
            licenseOrTermsUrl: "See ADS-B archives you ingest (often ODbL or provider-specific)",
          },
        ],
      },
    };
  } catch (e) {
    if (e.code === "INVALID_REGISTRATION")
      return { status: 400, body: { error: e.code, message: e.message } };
    if (e.code === "INVALID_DATE_RANGE")
      return { status: 400, body: { error: e.code, message: e.message } };
    if (e.code === "RANGE_TOO_LARGE")
      return { status: 400, body: { error: e.code, message: e.message } };
    console.error(e);
    return { status: 500, body: { error: "INTERNAL", message: "Unexpected server error" } };
  }
}

export async function handleFlights(reg, from, to) {
  try {
    if (!from || !to) {
      return {
        status: 400,
        body: { error: "BAD_REQUEST", message: "Query params `from` and `to` (YYYY-MM-DD) are required" },
      };
    }
    const registration = normalizeReg(reg);
    const info = await buildFlights(registration, String(from), String(to));
    return {
      status: 200,
      body: {
        registration: info.ac.registration,
        icao24: info.ac.icao24,
        from: info.from,
        to: info.to,
        flights: info.flights,
      },
    };
  } catch (e) {
    if (e.code === "INVALID_REGISTRATION")
      return { status: 400, body: { error: e.code, message: e.message } };
    if (e.code === "INVALID_DATE_RANGE")
      return { status: 400, body: { error: e.code, message: e.message } };
    if (e.code === "RANGE_TOO_LARGE")
      return { status: 400, body: { error: e.code, message: e.message } };
    console.error(e);
    return { status: 500, body: { error: "INTERNAL", message: "Unexpected server error" } };
  }
}

export async function handleTrack(reg, flightId, from, to, maxPoints, epsilonDeg) {
  try {
    if (!from || !to) {
      return {
        status: 400,
        body: { error: "BAD_REQUEST", message: "Query params `from` and `to` (YYYY-MM-DD) are required" },
      };
    }
    const registration = normalizeReg(reg);
    const ac = lookupAircraft(registration);
    const body = await flightTrack(ac, String(flightId), String(from), String(to), maxPoints, epsilonDeg);
    return { status: 200, body };
  } catch (e) {
    if (e.code === "INVALID_REGISTRATION")
      return { status: 400, body: { error: e.code, message: e.message } };
    if (e.code === "INVALID_DATE_RANGE")
      return { status: 400, body: { error: e.code, message: e.message } };
    if (e.code === "RANGE_TOO_LARGE")
      return { status: 400, body: { error: e.code, message: e.message } };
    if (e.code === "FLIGHT_NOT_FOUND")
      return { status: 404, body: { error: e.code, message: e.message } };
    console.error(e);
    return { status: 500, body: { error: "INTERNAL", message: "Unexpected server error" } };
  }
}
