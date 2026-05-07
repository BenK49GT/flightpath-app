import fs from "node:fs/promises";
import path from "node:path";

function traceDir(baseDir) {
  return path.join(baseDir, "data", "traces");
}

function fileForDay(traceBase, icao24, dayStartUtcMs) {
  const d = new Date(dayStartUtcMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = `${y}${mo}${day}`;
  return path.join(traceDir(traceBase), `${hh}_${icao24.toLowerCase()}.json`);
}

export async function loadPointsForRange({ traceBase, icao24, dayStartsUtcMs }) {
  const merged = [];
  const notes = [];

  for (const dayMs of dayStartsUtcMs) {
    const fp = fileForDay(traceBase, icao24, dayMs);
    try {
      const raw = await fs.readFile(fp, "utf8");
      const body = JSON.parse(raw);
      const pts = normalizeStoredPoints(body);
      merged.push(...pts);
      if (!pts.length) {
        notes.push(`empty_trace_file:${path.basename(fp)}`);
      }
    } catch (e) {
      if (e.code === "ENOENT") {
        /* no trace for day */
      } else {
        notes.push(`read_error:${path.basename(fp)}:${e.message}`);
      }
    }
  }

  merged.sort((a, b) => a.t - b.t);
  return { points: dedupeAdjacent(merged), notes };
}

function normalizeStoredPoints(body) {
  if (Array.isArray(body.points)) return body.points.map(normalizePoint).filter(Boolean);
  if (Array.isArray(body)) return body.map(normalizePoint).filter(Boolean);
  return [];
}

function normalizePoint(p) {
  if (!p || typeof p !== "object") return null;
  if (typeof p.t !== "number" || typeof p.lat !== "number" || typeof p.lon !== "number")
    return null;
  return {
    t: Math.floor(p.t),
    lat: p.lat,
    lon: p.lon,
    altFt: p.altFt ?? null,
    gsKt: p.gsKt ?? null,
    trackDeg: p.trackDeg ?? null,
  };
}

function dedupeAdjacent(pts) {
  const out = [];
  let last = null;
  for (const p of pts) {
    if (last && last.t === p.t && last.lat === p.lat && last.lon === p.lon) continue;
    out.push(p);
    last = p;
  }
  return out;
}
