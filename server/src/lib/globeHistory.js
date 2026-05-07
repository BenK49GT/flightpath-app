/**
 * ADS-B Exchange globe_history trace probes (same URL shape as fetch-traces-range / indy render).
 */

import { normalizeRawTraceToPoints } from "../../scripts/traceNormalize.mjs";
import { ymdFromUtcMs } from "./dates.js";

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
      return { ok: true, ymd, pointCount: points.length, kind, url };
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
  const n = Math.min(Math.max(Number(daysBack) || 90, 1), 366);
  const wait = Math.min(Math.max(Number(delayMs) || 100, 40), 800);

  for (let i = 0; i < n; i++) {
    const dayMs = startUtc - i * 86400000;
    const ymd = ymdFromUtcMs(dayMs);
    const r = await fetchGlobeTraceForDay(icaoLower, ymd);
    if (r.ok) out.push({ date: ymd, pointCount: r.pointCount, kind: r.kind });
    if (i + 1 < n) await new Promise((r2) => setTimeout(r2, wait));
  }

  return out;
}
