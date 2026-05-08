/**
 * ADS-B Exchange globe_history trace probes (same URL shape as fetch-traces-range / indy render).
 */

import { normalizeRawTraceToPoints } from "../../scripts/traceNormalize.mjs";
import { ymdFromUtcMs } from "./dates.js";
import { detectEndpointVisitedAirports, detectVisitedAirports } from "./nearestAirport.js";
import { segmentFlights } from "./segment.js";

/**
 * `points` come straight from normalizeRawTraceToPoints (parsed globe_history rows only — no kinematic smoothing).
 * Airports listed only where the trace shows on-field segments: slow taxi near the field (~1 NM, gs below 50 kt
 * or missing gs near-ground), or tight runway-roll samples (very close, moderate gs, low altitude).
 */
function summarizeDay(points) {
  const flights = segmentFlights(points, {});
  const totalFlightSec = flights.reduce((acc, f) => acc + Math.max(0, Number(f.durationSec) || 0), 0);
  const routeAirports = detectVisitedAirports(points);
  const endpointAirports = detectEndpointVisitedAirports(points, flights);

  const airportsSeen = new Map();
  const ordered = [...routeAirports, ...endpointAirports].sort(
    (a, b) => (a.firstT ?? Number.MAX_SAFE_INTEGER) - (b.firstT ?? Number.MAX_SAFE_INTEGER),
  );
  for (const ap of ordered) {
    if (!ap?.code) continue;
    const prev = airportsSeen.get(ap.code);
    const curT = ap.firstT ?? Number.MAX_SAFE_INTEGER;
    if (!prev || curT < prev.firstT) {
      airportsSeen.set(ap.code, {
        code: ap.code,
        name: ap.name || ap.code,
        firstT: curT,
        ...(ap.faaIdent ? { faaIdent: ap.faaIdent } : {}),
      });
    }
  }

  const airportsVisited = Array.from(airportsSeen.values())
    .sort((a, b) => a.firstT - b.firstT)
    .map(({ code, name, faaIdent }) => ({
      code,
      name,
      ...(faaIdent ? { faaIdent } : {}),
    }));

  return {
    totalFlightSec,
    airportsVisited,
  };
}

export function globeHistoryUrl(y, m, d, folder, icaoLower, kind) {
  const ic = icaoLower.toLowerCase();
  return `https://globe.adsbexchange.com/globe_history/${y}/${m}/${d}/traces/${folder}/${kind}_${ic}.json`;
}

export async function fetchGlobeTraceForDay(icaoLower, ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return { ok: false, reason: "bad_ymd" };
  const [, y, mo, d] = m;
  const folder = icaoLower.slice(-2);

  for (const kind of ["trace_full", "trace_recent"]) {
    const url = globeHistoryUrl(y, mo, d, folder, icaoLower, kind);
    const res = await fetch(url, {
      headers: {
        accept: "application/json,*/*",
        "user-agent":
          "Mozilla/5.0 (compatible; FlightpathWeb/1.0) AppleWebKit/537.36",
        referer: "https://globe.adsbexchange.com/",
      },
    });
    if (!res.ok) continue;
    let data;
    try {
      data = await res.json();
    } catch {
      continue;
    }
    const points = normalizeRawTraceToPoints(data);
    if (points?.length) {
      const summary = summarizeDay(points);
      return {
        ok: true,
        ymd,
        pointCount: points.length,
        kind,
        url,
        totalFlightSec: summary.totalFlightSec,
        airportsVisited: summary.airportsVisited,
      };
    }
  }
  return { ok: false, ymd };
}

/**
 * Scan UTC calendar days from "today" backward, return YYYY-MM-DD list with trace data.
 */
export async function listGlobeDatesWithData(icaoLower, daysBack, delayMs) {
  const out = [];
  const now = new Date();
  const startUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const n = Math.min(Math.max(Number(daysBack) || 90, 1), 3650);
  const wait = Math.min(Math.max(Number(delayMs) || 100, 40), 800);

  for (let i = 0; i < n; i++) {
    const dayMs = startUtc - i * 86400000;
    const ymd = ymdFromUtcMs(dayMs);
    const r = await fetchGlobeTraceForDay(icaoLower, ymd);
    if (r.ok) {
      out.push({
        date: ymd,
        totalFlightSec: r.totalFlightSec ?? 0,
        airportsVisited: r.airportsVisited ?? [],
        kind: r.kind,
      });
    }
    if (i + 1 < n) await new Promise((r2) => setTimeout(r2, wait));
  }

  return out;
}
