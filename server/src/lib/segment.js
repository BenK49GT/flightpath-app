function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Earth radius nautical miles
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function bboxFor(points) {
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  return { minLat, maxLat, minLon, maxLon };
}

/**
 * Segment a time-ordered sequence of ADS-B points into flights using simple heuristics
 * tuned for occasional GA traces (many gaps expected).
 *
 * opts:
 * - maxGapSec: split if gap exceeds
 * - maxJumpNm: split if consecutive points jump farther (teleport artifact)
 * - minPoints: discard segments shorter than this
 * - minDurationSec: discard segments shorter than this
 */
export function segmentFlights(sortedPoints, opts = {}) {
  const maxGapSec = opts.maxGapSec ?? 20 * 60;
  const maxJumpNm = opts.maxJumpNm ?? 80;
  const minPoints = opts.minPoints ?? 8;
  const minDurationSec = opts.minDurationSec ?? 3 * 60;

  const out = [];
  if (!sortedPoints.length) return out;

  let cur = [sortedPoints[0]];
  for (let i = 1; i < sortedPoints.length; i++) {
    const prev = sortedPoints[i - 1];
    const p = sortedPoints[i];
    const dt = p.t - prev.t;
    const jump = haversineNm(prev.lat, prev.lon, p.lat, p.lon);

    const split =
      dt > maxGapSec || (dt > 0 && jump > maxJumpNm && jump / Math.max(dt, 1) > 5);

    if (split) {
      out.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  out.push(cur);

  const flights = [];
  for (const seg of out) {
    if (!seg.length) continue;
    const start = seg[0].t;
    const end = seg[seg.length - 1].t;
    const dur = end - start;
    if (seg.length < minPoints || dur < minDurationSec) continue;

    flights.push({
      points: seg,
      startTimeUnix: start,
      endTimeUnix: end,
      durationSec: dur,
      pointCount: seg.length,
      bbox: bboxFor(seg),
    });
  }
  return flights;
}
