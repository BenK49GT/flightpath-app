/**
 * Build a render media manifest and map capture times onto the flight window.
 */

import { loadLocalTracePack } from "./lib/globeHistory.js";
import { segmentFlights } from "./lib/segment.js";

/**
 * Convert a per-day trace timestamp to Unix seconds.
 * Globe rows are often seconds-since-UTC-midnight; already-unix values pass through.
 */
export function absoluteUnixForDay(ymd, t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (n > 1e9) return Math.floor(n);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return Math.floor(n);
  const midnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  return Math.floor(midnight + n);
}

export function dayWindowFromPoints(ymd, points) {
  const abs = points
    .map((p) => absoluteUnixForDay(ymd, p.t))
    .filter((t) => Number.isFinite(t));
  if (!abs.length) return null;
  const withAbs = points
    .map((p) => ({ ...p, absT: absoluteUnixForDay(ymd, p.t) }))
    .filter((p) => Number.isFinite(p.absT))
    .sort((a, b) => a.absT - b.absT);
  const forSeg = withAbs.map((p) => ({ ...p, t: p.absT }));
  const flights = segmentFlights(forSeg, {});
  if (flights.length) {
    const best = [...flights].sort((a, b) => b.durationSec - a.durationSec || b.pointCount - a.pointCount)[0];
    return { startUnix: best.startTimeUnix, endUnix: best.endTimeUnix };
  }
  return { startUnix: Math.min(...abs), endUnix: Math.max(...abs) };
}

export function computeFlightWindowFromDates(icaoLower, dates) {
  let startUnix = Infinity;
  let endUnix = -Infinity;
  const used = [];
  for (const ymd of dates) {
    const pack = loadLocalTracePack(icaoLower, ymd);
    if (!pack?.points?.length) continue;
    const w = dayWindowFromPoints(ymd, pack.points);
    if (!w) continue;
    startUnix = Math.min(startUnix, w.startUnix);
    endUnix = Math.max(endUnix, w.endUnix);
    used.push(ymd);
  }
  if (!used.length) {
    return { ok: false, startUnix: null, endUnix: null, dates: [] };
  }
  return { ok: true, startUnix, endUnix, dates: used };
}

export function filterMediaByWindow(items, startUnix, endUnix) {
  if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix) || endUnix <= startUnix) {
    return items.slice();
  }
  const pad = 15 * 60;
  const lo = startUnix - pad;
  const hi = endUnix + pad;
  return items.filter((it) => {
    const t = Number(it.createTimeUnix);
    return Number.isFinite(t) && t >= lo && t <= hi;
  });
}

export function buildMediaManifest({ items, startUnix, endUnix, filterByFlightTime }) {
  const canFilter = filterByFlightTime && Number.isFinite(startUnix) && Number.isFinite(endUnix);
  const filtered = canFilter ? filterMediaByWindow(items, startUnix, endUnix) : items.slice();
  return {
    items: filtered.map((it) => ({
      path: it.path,
      type: it.type === "video" ? "video" : "photo",
      createTimeUnix: it.createTimeUnix,
      durationSec: it.type === "video" ? 4 : 2.5,
    })),
    legStartUnix: startUnix,
    legEndUnix: endUnix,
    filterByFlightTime: Boolean(filterByFlightTime),
    pickedCount: items.length,
    includedCount: filtered.length,
  };
}

/**
 * Map media capture times onto animation frames (index-based flight progress).
 */
export function scheduleMediaOverlays(manifest, { totalFrames, fps }) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const start = Number(manifest.legStartUnix);
  const end = Number(manifest.legEndUnix);
  const span = end - start;
  const scheduled = [];
  if (!items.length || !Number.isFinite(start) || !Number.isFinite(end) || span <= 0) {
    return scheduled;
  }
  const sorted = [...items].sort((a, b) => (a.createTimeUnix || 0) - (b.createTimeUnix || 0));
  let lastEnd = -1;
  for (const it of sorted) {
    const t = Number(it.createTimeUnix);
    if (!Number.isFinite(t)) continue;
    const u = Math.max(0, Math.min(1, (t - start) / span));
    const progress = 0.04 + u * 0.96;
    let startFrame = Math.round(progress * Math.max(1, totalFrames - 1));
    const durSec = Math.max(1.2, Number(it.durationSec) || 2.5);
    const durFrames = Math.max(Math.round(durSec * fps), Math.round(1.2 * fps));
    if (startFrame < lastEnd) startFrame = lastEnd;
    if (startFrame >= totalFrames) continue;
    const endFrame = Math.min(totalFrames, startFrame + durFrames);
    scheduled.push({
      path: it.path,
      type: it.type,
      startFrame,
      endFrame,
      createTimeUnix: t,
    });
    lastEnd = endFrame;
  }
  return scheduled;
}
