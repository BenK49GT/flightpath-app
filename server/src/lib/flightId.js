export function makeFlightId(icao24, startTimeUnix) {
  return `${icao24.toLowerCase()}_${startTimeUnix}`;
}

export function parseFlightId(id) {
  const m = /^([0-9a-f]{6})_(\d+)$/.exec(String(id || ""));
  if (!m) return null;
  return { icao24: m[1], startTimeUnix: Number(m[2]) };
}
