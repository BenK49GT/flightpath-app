/**
 * ADS-B Exchange globe_history trace probes (same URL shape as fetch-traces-range / indy render).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeRawTraceToPoints } from "../../scripts/traceNormalize.mjs";
import { ymdFromUtcMs } from "./dates.js";
import { detectEndpointVisitedAirports, detectVisitedAirports } from "./nearestAirport.js";
import { segmentFlights } from "./segment.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACES_DIR = path.join(__dirname, "..", "..", "data", "traces");

const GLOBE_FETCH_HEADERS = {
  accept: "application/json,*/*",
  "user-agent": "Mozilla/5.0 (compatible; FlightpathWeb/1.1) AppleWebKit/537.36",
  referer: "https://globe.adsbexchange.com/",
};

/** Between trace_full / trace_recent attempts on the same day. */
const SCRAPE_KIND_DELAY_MS = Math.min(
  Math.max(Number(process.env.INDY_GLOBE_KIND_DELAY_MS) || 80, 0),
  2000,
);
const SCRAPE_RETRY_MAX = Math.min(Math.max(Number(process.env.INDY_GLOBE_RETRY_MAX) || 4, 0), 8);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch globe_history JSON with backoff on 429 / 502 / 503.
 */
export async function fetchGlobeHistoryJson(url, opts = {}) {
  const retries = opts.retries ?? SCRAPE_RETRY_MAX;
  const baseDelayMs =
    opts.baseDelayMs ??
    Math.min(Math.max(Number(process.env.INDY_GLOBE_DELAY_MS) || 120, 40), 2000);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: GLOBE_FETCH_HEADERS });
    if (res.ok) {
      try {
        const data = await res.json();
        return { ok: true, data, status: res.status };
      } catch {
        return { ok: false, status: "parse-error" };
      }
    }
    const retryable = res.status === 429 || res.status === 503 || res.status === 502;
    if (retryable && attempt < retries) {
      const wait = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 150);
      await sleep(wait);
      continue;
    }
    return { ok: false, status: res.status };
  }
  return { ok: false, status: "max-retries" };
}

export function loadLocalTracePack(icaoLower, ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return null;
  const ymdCompact = `${m[1]}${m[2]}${m[3]}`;
  const p = path.join(TRACES_DIR, `${ymdCompact}_${icaoLower.toLowerCase()}.json`);
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const points = normalizeRawTraceToPoints(raw);
  if (!points?.length) return null;
  return {
    source: "local-fallback",
    path: p,
    ymd,
    points,
  };
}

export function saveLocalTracePack(icaoLower, ymd, raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return null;
  const ymdCompact = `${m[1]}${m[2]}${m[3]}`;
  const points = normalizeRawTraceToPoints(raw);
  if (!points?.length) return null;
  fs.mkdirSync(TRACES_DIR, { recursive: true });
  const p = path.join(TRACES_DIR, `${ymdCompact}_${icaoLower.toLowerCase()}.json`);
  fs.writeFileSync(p, JSON.stringify({ points }, null, 2), "utf8");
  return p;
}

/** Days with cached traces under server/data/traces/ for this ICAO. */
export function listLocalTraceDaySummaries(icaoLower) {
  const ic = icaoLower.toLowerCase();
  const suffix = `_${ic}.json`;
  if (!fs.existsSync(TRACES_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(TRACES_DIR)) {
    if (!name.endsWith(suffix) || name.length < 8 + suffix.length) continue;
    const ymdCompact = name.slice(0, 8);
    const ymd = `${ymdCompact.slice(0, 4)}-${ymdCompact.slice(4, 6)}-${ymdCompact.slice(6, 8)}`;
    const local = loadLocalTracePack(ic, ymd);
    if (!local) continue;
    const summary = summarizeDay(local.points);
    out.push({
      date: ymd,
      totalFlightSec: summary.totalFlightSec,
      airportsVisited: summary.airportsVisited,
      kind: "local-cache",
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

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

export async function fetchGlobeTraceForDay(icaoLower, ymd, opts = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return { ok: false, reason: "bad_ymd" };

  if (!opts.skipLocal) {
    const local = loadLocalTracePack(icaoLower, ymd);
    if (local) {
      const summary = summarizeDay(local.points);
      return {
        ok: true,
        ymd,
        pointCount: local.points.length,
        kind: "local-cache",
        url: null,
        cached: true,
        totalFlightSec: summary.totalFlightSec,
        airportsVisited: summary.airportsVisited,
      };
    }
  }

  const [, y, mo, d] = m;
  const folder = icaoLower.slice(-2);
  const fetchOpts = opts.retries != null ? { retries: opts.retries } : {};

  for (let ki = 0; ki < 2; ki++) {
    const kind = ki === 0 ? "trace_full" : "trace_recent";
    const url = globeHistoryUrl(y, mo, d, folder, icaoLower, kind);
    const { ok, data, status } = await fetchGlobeHistoryJson(url, fetchOpts);
    if (!ok) {
      if (status === 429) return { ok: false, ymd, rateLimited: true, status };
      if (ki === 0 && SCRAPE_KIND_DELAY_MS > 0) await sleep(SCRAPE_KIND_DELAY_MS);
      continue;
    }
    const points = normalizeRawTraceToPoints(data);
    if (points?.length) {
      const summary = summarizeDay(points);
      try {
        saveLocalTracePack(icaoLower, ymd, data);
      } catch {
        /* cache optional */
      }
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
    if (ki === 0 && SCRAPE_KIND_DELAY_MS > 0) await sleep(SCRAPE_KIND_DELAY_MS);
  }
  return { ok: false, ymd };
}

/**
 * Full trace pack for render / ingest (points + optional raw for cache).
 * Returns null if no data; { rateLimited: true } if ADS-B Exchange returned 429 after retries.
 */
export async function fetchGlobeTracePackForDay(icaoLower, ymd, log = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return null;
  const [, y, mo, d] = m;
  const folder = icaoLower.slice(-2);
  let saw429 = false;

  for (let ki = 0; ki < 2; ki++) {
    const kind = ki === 0 ? "trace_full" : "trace_recent";
    const url = globeHistoryUrl(y, mo, d, folder, icaoLower, kind);
    if (log) process.stderr.write(`Scrape: GET ${url} … `);
    const { ok, data, status } = await fetchGlobeHistoryJson(url);
    if (!ok) {
      if (status === 429) saw429 = true;
      if (log) console.error(status);
      if (ki === 0 && SCRAPE_KIND_DELAY_MS > 0) await sleep(SCRAPE_KIND_DELAY_MS);
      continue;
    }
    const points = normalizeRawTraceToPoints(data);
    if (!points?.length) {
      if (log) console.error("no parseable points");
      if (ki === 0 && SCRAPE_KIND_DELAY_MS > 0) await sleep(SCRAPE_KIND_DELAY_MS);
      continue;
    }
    if (log) console.error(`ok → ${points.length} raw points`);
    try {
      saveLocalTracePack(icaoLower, ymd, data);
    } catch {
      /* cache optional */
    }
    return { source: "globe.adsbexchange.com", url, ymd, points, raw: data };
  }
  if (saw429) return { rateLimited: true, status: 429 };
  return null;
}

/**
 * Scan UTC calendar days from "today" backward, return YYYY-MM-DD list with trace data.
 * Merges local cache; stops early if ADS-B Exchange keeps returning 429.
 */
export async function listGlobeDatesWithData(icaoLower, daysBack, delayMs) {
  const byDate = new Map();
  for (const row of listLocalTraceDaySummaries(icaoLower)) {
    byDate.set(row.date, row);
  }

  const now = new Date();
  const startUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const n = Math.min(Math.max(Number(daysBack) || 90, 1), 3650);
  const wait = Math.min(Math.max(Number(delayMs) || 100, 40), 800);
  let consecutive429 = 0;
  let remoteHits = 0;
  let daysProbed = 0;
  const maxConsecutive429 = Math.min(
    Math.max(Number(process.env.INDY_GLOBE_ABORT_AFTER_429) || 10, 3),
    40,
  );

  for (let i = 0; i < n; i++) {
    const dayMs = startUtc - i * 86400000;
    const ymd = ymdFromUtcMs(dayMs);
    daysProbed += 1;
    if (byDate.has(ymd)) {
      // Already have summary (local cache or earlier hit) — do not re-scrape.
      consecutive429 = 0;
      continue;
    }

    const r = await fetchGlobeTraceForDay(icaoLower, ymd, { skipLocal: true, retries: 1 });
    if (r.rateLimited) {
      consecutive429 += 1;
      if (consecutive429 >= maxConsecutive429) break;
    } else {
      consecutive429 = 0;
    }
    if (r.ok) {
      remoteHits += 1;
      byDate.set(ymd, {
        date: ymd,
        totalFlightSec: r.totalFlightSec ?? 0,
        airportsVisited: r.airportsVisited ?? [],
        kind: r.kind,
      });
    }
    if (i + 1 < n) await sleep(wait);
  }

  const dates = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  const rateLimited = consecutive429 >= maxConsecutive429;
  return {
    dates,
    rateLimited,
    scanStoppedEarly: rateLimited && daysProbed < n,
    daysProbed,
    remoteHits,
    localCached: dates.filter((d) => d.kind === "local-cache").length,
  };
}
