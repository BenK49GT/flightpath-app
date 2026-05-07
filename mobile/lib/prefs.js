import AsyncStorage from "@react-native-async-storage/async-storage";

const V = "flightpath:v1:";

export async function loadPrefs() {
  try {
    const raw = await AsyncStorage.getItem(V + "prefs");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function savePrefs(prefs) {
  try {
    await AsyncStorage.setItem(V + "prefs", JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function flightsCacheKey(reg, from, to) {
  const r = String(reg || "")
    .trim()
    .toUpperCase();
  return V + `flights:${r}:${from}:${to}`;
}

export function trackCacheKey(flightId, from, to) {
  return V + `track:${flightId}:${from}:${to}`;
}

export async function loadFlightsCache(reg, from, to) {
  try {
    const raw = await AsyncStorage.getItem(flightsCacheKey(reg, from, to));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveFlightsCache(reg, from, to, flights) {
  try {
    await AsyncStorage.setItem(flightsCacheKey(reg, from, to), JSON.stringify(flights));
  } catch {
    /* ignore */
  }
}

export async function loadTrackCache(flightId, from, to) {
  try {
    const raw = await AsyncStorage.getItem(trackCacheKey(flightId, from, to));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveTrackCache(flightId, from, to, coords) {
  try {
    await AsyncStorage.setItem(trackCacheKey(flightId, from, to), JSON.stringify(coords));
  } catch {
    /* ignore */
  }
}
