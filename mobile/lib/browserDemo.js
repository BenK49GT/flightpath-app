import { Platform } from "react-native";

import demoFlights from "../assets/demo/flights.json";
import demoTrack from "../assets/demo/track.json";

export const BROWSER_DEMO_DAY = "2026-04-24";

export function isBrowserBundledMode(apiBase) {
  return Platform.OS === "web" && !String(apiBase || "").trim();
}

export function rangeContainsDemoDay(from, to) {
  return String(from) <= BROWSER_DEMO_DAY && BROWSER_DEMO_DAY <= String(to);
}

export function getBrowserDemoFlights(reg, from, to) {
  const r = String(reg || "").trim().toUpperCase();
  if (r !== demoFlights.registration) {
    return {
      ok: false,
      message: `Browser demo includes one sample aircraft: ${demoFlights.registration}.`,
    };
  }
  if (!rangeContainsDemoDay(from, to)) {
    return {
      ok: false,
      message: `Browser demo includes data for ${BROWSER_DEMO_DAY} only. Adjust your date range.`,
    };
  }
  return { ok: true, flights: demoFlights.flights };
}

export function getBrowserDemoTrackCoords(flightId) {
  if (String(flightId) !== String(demoTrack.flightId)) return null;
  return (demoTrack.points || []).map((p) => ({ latitude: p.lat, longitude: p.lon }));
}
