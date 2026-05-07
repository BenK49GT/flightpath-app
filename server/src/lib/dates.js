export function parseYmdUtc(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const start = Date.UTC(y, mo - 1, d, 0, 0, 0);
  if (Number.isNaN(start)) return null;
  return start;
}

export function eachUtcDayInclusive(fromYmd, toYmd) {
  const start = parseYmdUtc(fromYmd);
  const end = parseYmdUtc(toYmd);
  if (start === null || end === null || end < start) return [];
  const out = [];
  for (let t = start; t <= end; t += 86400000) {
    out.push(t);
  }
  return out;
}

export function ymdFromUtcMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function utcDayBoundsMs(dayStartUtcMs) {
  return {
    dayStartUtcSec: Math.floor(dayStartUtcMs / 1000),
    dayEndUtcSec: Math.floor(dayStartUtcMs / 1000) + 86400 - 1,
  };
}
