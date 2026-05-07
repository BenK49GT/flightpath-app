/**
 * Normalize readsb / tar1090 trace JSON into { t, lat, lon, altFt?, gsKt?, trackDeg? }[]
 */

export function normalizeTime(t) {
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  if (t > 1e12) return Math.floor(t / 1000);
  if (t > 1e10) return Math.floor(t / 1000);
  return Math.floor(t);
}

export function extractTraceArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.trace)) return obj.trace;
  if (Array.isArray(obj.points)) return obj.points;
  return null;
}

export function rowToPoint(row) {
  if (!Array.isArray(row) || row.length < 3) return null;
  const r0 = Number(row[0]);
  const r1 = Number(row[1]);
  const r2 = Number(row[2]);
  const plausibleLatLon = (a, b) =>
    Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180;

  let lat;
  let lon;
  let alt;
  let tRaw;
  let gsKt = null;
  let trackDeg = null;

  /**
   * ADS-B Exchange `globe_history` compact rows are typically:
   *   [t, lat, lon, alt, gsKt, trackDeg, …]
   * Older readsb dumps often use:
   *   [lat, lon, alt, t, …]
   */
  if (Math.abs(r0) > 90 && plausibleLatLon(r1, r2)) {
    tRaw = r0;
    lat = r1;
    lon = r2;
    alt = row[3] != null ? Number(row[3]) : null;
    gsKt = row[4] != null ? Number(row[4]) : null;
    trackDeg = row[5] != null ? Number(row[5]) : null;
  } else if (plausibleLatLon(r0, r1)) {
    lat = r0;
    lon = r1;
    alt = row[2] != null ? Number(row[2]) : null;
    tRaw = row[3] != null ? Number(row[3]) : null;
    gsKt = row[4] != null ? Number(row[4]) : null;
    trackDeg = row[5] != null ? Number(row[5]) : null;
  } else {
    return null;
  }

  const t = normalizeTime(tRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || t === null) return null;
  return {
    t,
    lat,
    lon,
    altFt: Number.isFinite(alt) ? alt : null,
    gsKt: Number.isFinite(gsKt) ? gsKt : null,
    trackDeg: Number.isFinite(trackDeg) ? trackDeg : null,
  };
}

export function normalizeRawTraceToPoints(raw) {
  const arr = extractTraceArray(raw);
  if (!arr || arr.length === 0) return null;
  const first = arr[0];
  if (
    first &&
    typeof first === "object" &&
    !Array.isArray(first) &&
    typeof first.t === "number" &&
    typeof first.lat === "number" &&
    typeof first.lon === "number"
  ) {
    const points = arr
      .filter((p) => p && typeof p.t === "number" && typeof p.lat === "number" && typeof p.lon === "number")
      .map((p) => ({
        t: Math.floor(p.t),
        lat: p.lat,
        lon: p.lon,
        altFt: p.altFt ?? null,
        gsKt: p.gsKt ?? null,
        trackDeg: p.trackDeg ?? null,
      }));
    points.sort((a, b) => a.t - b.t);
    return points.length ? points : null;
  }
  const points = arr.map(rowToPoint).filter(Boolean);
  points.sort((a, b) => a.t - b.t);
  return points.length ? points : null;
}
