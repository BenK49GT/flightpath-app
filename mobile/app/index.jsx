import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useRouter } from "expo-router";

import { defaultApiBase } from "../lib/apiBase";
import {
  BROWSER_DEMO_DAY,
  getBrowserDemoFlights,
  isBrowserBundledMode,
} from "../lib/browserDemo";
import { formatYmd, parseYmd } from "../lib/dates";
import {
  loadFlightsCache,
  loadPrefs,
  saveFlightsCache,
  savePrefs,
} from "../lib/prefs";

function formatDuration(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export const options = {
  title: "Flightpath",
  headerLargeTitle: false,
};

export default function HomeScreen() {
  const router = useRouter();
  const [apiBase, setApiBase] = useState(defaultApiBase());
  const [reg, setReg] = useState("N49GT");
  const [from, setFrom] = useState("2026-04-24");
  const [to, setTo] = useState("2026-04-24");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [flights, setFlights] = useState([]);
  const [cacheHint, setCacheHint] = useState(null);
  const [showFrom, setShowFrom] = useState(false);
  const [showTo, setShowTo] = useState(false);

  const base = useMemo(() => apiBase.replace(/\/$/, ""), [apiBase]);

  useEffect(() => {
    (async () => {
      const p = await loadPrefs();
      if (p.apiBase) setApiBase(p.apiBase);
      if (p.reg) setReg(p.reg);
      if (p.from) setFrom(p.from);
      if (p.to) setTo(p.to);
    })();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      savePrefs({ apiBase, reg, from, to });
    }, 500);
    return () => clearTimeout(t);
  }, [apiBase, reg, from, to]);

  const loadFlights = useCallback(async () => {
    setError(null);
    setCacheHint(null);
    setLoading(true);
    try {
      if (isBrowserBundledMode(base)) {
        const demo = getBrowserDemoFlights(reg, from, to);
        if (!demo.ok) {
          setFlights([]);
          setError(demo.message);
          return;
        }
        setFlights(demo.flights);
        setCacheHint(`Browser demo — ${BROWSER_DEMO_DAY}, bundled track (no server).`);
        return;
      }

      if (!base.trim()) {
        setFlights([]);
        setError("Enter an API base URL (your Flightpath server), or open the app in a browser for the offline demo.");
        return;
      }

      const enc = encodeURIComponent(reg.trim().toUpperCase());
      const url = `${base}/api/aircraft/${enc}/flights?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }
      const list = data.flights || [];
      setFlights(list);
      await saveFlightsCache(reg, from, to, list);
      if (!list.length) {
        setError("No flights in range. Seed demo (`npm run seed-demo`) or fetch traces on the server.");
      }
    } catch (e) {
      setFlights([]);
      const msg = String(e.message || e);
      setError(msg);
      const cached = await loadFlightsCache(reg, from, to);
      if (cached?.length) {
        setCacheHint(`${cached.length} flight(s) in offline cache — tap “Load cached”.`);
        Alert.alert("Network error", msg, [
          { text: "Dismiss", style: "cancel" },
          {
            text: "Load cached",
            onPress: () => {
              setFlights(cached);
              setError(null);
              setCacheHint("Showing cached flights.");
            },
          },
        ]);
      }
    } finally {
      setLoading(false);
    }
  }, [base, reg, from, to]);

  const loadCachedOnly = useCallback(async () => {
    setError(null);
    setCacheHint(null);
    const cached = await loadFlightsCache(reg, from, to);
    if (!cached?.length) {
      setError("No cached flights for this N-number and date range.");
      return;
    }
    setFlights(cached);
    setCacheHint("Showing cached flights.");
  }, [reg, from, to]);

  const openFlight = useCallback(
    (item) => {
      router.push({
        pathname: "/flight/[flightId]",
        params: {
          flightId: item.id,
          registration: reg.trim().toUpperCase(),
          from,
          to,
          apiBase: base,
        },
      });
    },
    [router, reg, from, to, base],
  );

  const onFromChange = (event, date) => {
    if (Platform.OS === "android") setShowFrom(false);
    if (event?.type === "dismissed") return;
    if (date) setFrom(formatYmd(date));
  };

  const onToChange = (event, date) => {
    if (Platform.OS === "android") setShowTo(false);
    if (event?.type === "dismissed") return;
    if (date) setTo(formatYmd(date));
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom", "left", "right"]}>
      <Text style={styles.sub}>N-number + date range → pick a leg for the map</Text>

      <Text style={styles.label}>API base (optional in browser)</Text>
      <TextInput
        style={styles.input}
        value={apiBase}
        onChangeText={setApiBase}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={Platform.OS === "web" ? "Leave empty for bundled demo" : "http://192.168.x.x:8787"}
      />
      {Platform.OS === "web" ? (
        <Text style={styles.hint}>
          Empty API base uses offline sample data (N49GT, {BROWSER_DEMO_DAY}). Add your server URL for live traces.
        </Text>
      ) : null}

      <View style={styles.row}>
        <View style={styles.rowItem}>
          <Text style={styles.label}>N-number</Text>
          <TextInput style={styles.input} value={reg} onChangeText={setReg} autoCapitalize="characters" />
        </View>
      </View>

      <View style={styles.row}>
        <View style={styles.rowItem}>
          <Text style={styles.label}>From</Text>
          {Platform.OS === "web" ? (
            <TextInput
              style={styles.input}
              value={from}
              onChangeText={setFrom}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              autoCorrect={false}
            />
          ) : (
            <Pressable style={styles.dateBtn} onPress={() => setShowFrom(true)}>
              <Text style={styles.dateBtnText}>{from}</Text>
            </Pressable>
          )}
        </View>
        <View style={styles.rowItem}>
          <Text style={styles.label}>To</Text>
          {Platform.OS === "web" ? (
            <TextInput
              style={styles.input}
              value={to}
              onChangeText={setTo}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              autoCorrect={false}
            />
          ) : (
            <Pressable style={styles.dateBtn} onPress={() => setShowTo(true)}>
              <Text style={styles.dateBtnText}>{to}</Text>
            </Pressable>
          )}
        </View>
      </View>

      {Platform.OS === "ios" ? (
        <Modal visible={showFrom} animationType="slide" transparent>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <DateTimePicker
                value={parseYmd(from)}
                mode="date"
                display="spinner"
                themeVariant="dark"
                onChange={onFromChange}
                style={styles.picker}
              />
              <Pressable style={styles.modalDone} onPress={() => setShowFrom(false)}>
                <Text style={styles.modalDoneText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : Platform.OS === "android" ? (
        showFrom && (
          <DateTimePicker value={parseYmd(from)} mode="date" display="default" onChange={onFromChange} />
        )
      ) : null}

      {Platform.OS === "ios" ? (
        <Modal visible={showTo} animationType="slide" transparent>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <DateTimePicker
                value={parseYmd(to)}
                mode="date"
                display="spinner"
                themeVariant="dark"
                onChange={onToChange}
                style={styles.picker}
              />
              <Pressable style={styles.modalDone} onPress={() => setShowTo(false)}>
                <Text style={styles.modalDoneText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : Platform.OS === "android" ? (
        showTo && <DateTimePicker value={parseYmd(to)} mode="date" display="default" onChange={onToChange} />
      ) : null}

      <View style={styles.btnRow}>
        <Pressable style={[styles.button, styles.buttonFlex]} onPress={loadFlights} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Load flights</Text>}
        </Pressable>
        <Pressable style={[styles.buttonSecondary, styles.buttonFlex]} onPress={loadCachedOnly}>
          <Text style={styles.buttonSecondaryText}>Cached</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {cacheHint ? <Text style={styles.hint}>{cacheHint}</Text> : null}

      <Text style={styles.section}>Flights</Text>
      <FlatList
        data={flights}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={
          !loading && !error ? <Text style={styles.muted}>Load to see legs for this range.</Text> : null
        }
        renderItem={({ item }) => {
          const o = item.originGuess?.code;
          const d = item.destinationGuess?.code;
          return (
            <Pressable style={styles.card} onPress={() => openFlight(item)}>
              <Text style={styles.cardTitle}>{item.id}</Text>
              <Text style={styles.cardMeta}>
                {o || "?"} → {d || "?"} · {formatDuration(item.durationSec)} · {item.pointCount} pts
              </Text>
              <Text style={styles.cardCta}>Open map →</Text>
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#1a1a2e", paddingHorizontal: 16 },
  sub: { fontSize: 13, color: "#a0a0a0", marginBottom: 12, marginTop: 4 },
  label: { fontSize: 12, color: "#888", marginBottom: 4 },
  input: {
    backgroundColor: "#16213e",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#eaeaea",
    marginBottom: 10,
  },
  dateBtn: {
    backgroundColor: "#16213e",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 10,
  },
  dateBtnText: { color: "#eaeaea", fontSize: 16 },
  row: { flexDirection: "row", gap: 10 },
  rowItem: { flex: 1 },
  btnRow: { flexDirection: "row", gap: 10, marginBottom: 8 },
  button: {
    backgroundColor: "#e94560",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonFlex: { flex: 1 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  buttonSecondary: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e94560",
    justifyContent: "center",
  },
  buttonSecondaryText: { color: "#e94560", fontWeight: "600", fontSize: 16 },
  error: { color: "#ff6b6b", marginVertical: 8, fontSize: 13 },
  hint: { color: "#7bed9f", marginBottom: 8, fontSize: 13 },
  section: { fontSize: 14, fontWeight: "600", color: "#ccc", marginTop: 8, marginBottom: 6 },
  list: { flex: 1 },
  muted: { color: "#666", fontSize: 13, paddingVertical: 8 },
  card: {
    backgroundColor: "#16213e",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#2a3555",
  },
  cardTitle: { color: "#eaeaea", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12 },
  cardMeta: { color: "#aaa", fontSize: 12, marginTop: 4 },
  cardCta: { color: "#e94560", fontSize: 12, marginTop: 8, fontWeight: "600" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#16213e",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 24,
  },
  picker: { alignSelf: "center" },
  modalDone: {
    marginHorizontal: 16,
    backgroundColor: "#e94560",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  modalDoneText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
