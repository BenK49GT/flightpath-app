export function lerpGreatCircle(lat1, lon1, lat2, lon2, frac) {
  const phi1 = (lat1 * Math.PI) / 180,
    lm1 = (lon1 * Math.PI) / 180,
    phi2 = (lat2 * Math.PI) / 180,
    lm2 = (lon2 * Math.PI) / 180;

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((phi2 - phi1) / 2) ** 2 +
          Math.cos(phi1) * Math.cos(phi2) * Math.sin((lm2 - lm1) / 2) ** 2,
      ),
    );

  if (d === 0) return { lat: lat1, lon: lon1 };

  const a = Math.sin((1 - frac) * d) / Math.sin(d);
  const b = Math.sin(frac * d) / Math.sin(d);
  const x = a * Math.cos(phi1) * Math.cos(lm1) + b * Math.cos(phi2) * Math.cos(lm2);
  const y = a * Math.cos(phi1) * Math.sin(lm1) + b * Math.cos(phi2) * Math.sin(lm2);
  const z = a * Math.sin(phi1) + b * Math.sin(phi2);
  const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
  const lon = Math.atan2(y, x);
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}
