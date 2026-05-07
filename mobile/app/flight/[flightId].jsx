import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import MapView, { Polyline } from "react-native-maps";
import { useLocalSearchParams } from "expo-router";
import Svg, { Polyline as SvgPolyline } from "react-native-svg";

import {
  getBrowserDemoTrackCoords,
  isBrowserBundledMode,
  rangeContainsDemoDay,
} from "../../lib/browserDemo";
import { loadTrackCache, saveTrackCache } from "../../lib/prefs";

export const options = {
  title: "Track",
};

function regionFromLatLngs(coords) {
  if (!coords.length) {
    return {
      latitude: 40.7,
      longitude: -73.9,
      latitudeDelta: 2,
      longitudeDelta: 2,
    };
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const c of coords) {
    minLat = Math.min(minLat, c.latitude);
    maxLat = Math.max(maxLat, c.latitude);
    minLon = Math.min(minLon, c.longitude);
    maxLon = Math.max(maxLon, c.longitude);
  }
  const latPad = Math.max((maxLat - minLat) * 0.35, 0.04);
  const lonPad = Math.max((maxLon - minLon) * 0.35, 0.04);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max(maxLat - minLat + latPad, 0.08),
    longitudeDelta: Math.max(maxLon - minLon + lonPad, 0.08),
  };
}

function WebSvgTrack({ coords }) {
  const size = 360;
  const pad = 20;
  if (coords.length < 2) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const c of coords) {
    minLat = Math.min(minLat, c.latitude);
    maxLat = Math.max(maxLat, c.latitude);
    minLon = Math.min(minLon, c.longitude);
    maxLon = Math.max(maxLon, c.longitude);
  }
  const latSpan = Math.max(maxLat - minLat, 1e-6);
  const lonSpan = Math.max(maxLon - minLon, 1e-6);
  const inner = size - pad * 2;
  const pts = coords
    .map((c) => {
      const x = pad + ((c.longitude - minLon) / lonSpan) * inner;
      const y = pad + ((maxLat - c.latitude) / latSpan) * inner;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <Svg width="100%" height={size} viewBox={`0 0 ${size} ${size}`}>
      <SvgPolyline
        points={pts}
        fill="none"
        stroke="#e94560"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export default function FlightTrackScreen() {
  const params = useLocalSearchParams();
  const pick = (v) => (Array.isArray(v) ? v[0] : v);
  const flightId = pick(params.flightId);
  const registration = pick(params.registration);
  const from = pick(params.from);
  const to = pick(params.to);
  const apiBase = String(pick(params.apiBase) || "").replace(/\/$/, "");

  const [coords, setCoords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);

  const mapRegion = useMemo(() => regionFromLatLngs(coords), [coords]);

  const load = useCallback(async () => {
    if (!flightId || !registration || !from || !to) {
      setStatus("Missing route params. Go back and open a flight again.");
      setLoading(false);
      return;
    }

    const bundled = isBrowserBundledMode(apiBase);
    if (!bundled && !apiBase) {
      setStatus("Set an API base on the home screen, or open this app in the browser with an empty API base for the demo.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setStatus(null);

    if (bundled) {
      const regOk = String(registration).trim().toUpperCase() === "N49GT";
      const dayOk = rangeContainsDemoDay(from, to);
      if (!regOk || !dayOk) {
        setCoords([]);
        setStatus("This flight is not included in the browser demo.");
        setLoading(false);
        return;
      }
      const next = getBrowserDemoTrackCoords(flightId);
      if (!next?.length) {
        setCoords([]);
        setStatus("Demo track not found for this flight.");
        setLoading(false);
        return;
      }
      setCoords(next);
      setStatus(null);
      setLoading(false);
      return;
    }

    const cached = await loadTrackCache(flightId, from, to);
    if (cached?.length) {
      setCoords(cached);
      setStatus("Showing cached track…");
    }

    try {
      const enc = encodeURIComponent(registration);
      const url = `${apiBase}/api/aircraft/${enc}/flights/${encodeURIComponent(flightId)}/track?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&maxPoints=2000&epsilonDeg=0.02`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }
      const next = (data.points || []).map((p) => ({
        latitude: p.lat,
        longitude: p.lon,
      }));
      setCoords(next);
      await saveTrackCache(flightId, from, to, next);
      setStatus(null);
    } catch (e) {
      if (!cached?.length) {
        setCoords([]);
        setStatus(String(e.message || e));
      } else {
        setStatus(`Offline — ${String(e.message || e)}`);
      }
    } finally {
      setLoading(false);
    }
  }, [flightId, registration, from, to, apiBase]);

  useEffect(() => {
    load();
  }, [load]);

  const mapBlock =
    Platform.OS === "web" ? (
      <View style={[styles.map, styles.webMapWrap]}>
        <Text style={styles.webMapCaption}>Track preview (browser)</Text>
        <WebSvgTrack coords={coords} />
        <Text style={styles.webMapMeta}>
          {coords.length ? `${coords.length} points` : loading ? "Loading…" : "No points yet"} · use iOS/Android for
          an interactive map
        </Text>
      </View>
    ) : (
      <MapView style={styles.map} region={mapRegion}>
        {coords.length > 1 ? (
          <Polyline coordinates={coords} strokeColor="#e94560" strokeWidth={4} />
        ) : null}
      </MapView>
    );

  return (
    <View style={styles.wrap}>
      {loading && coords.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#e94560" />
        </View>
      ) : null}
      {status ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{status}</Text>
        </View>
      ) : null}
      {mapBlock}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#1a1a2e" },
  map: { flex: 1 },
  webMapWrap: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: "#2a3555",
    alignItems: "stretch",
  },
  webMapCaption: { color: "#ccc", fontSize: 12, marginBottom: 8 },
  webMapMeta: { color: "#7bed9f", fontSize: 12, marginTop: 10 },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    backgroundColor: "rgba(26,26,46,0.35)",
  },
  banner: {
    backgroundColor: "#16213e",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#2a3555",
  },
  bannerText: { color: "#feca57", fontSize: 13 },
});
