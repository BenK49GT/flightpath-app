import { Platform } from "react-native";
import Constants from "expo-constants";

export function defaultApiBase() {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE;
  if (fromEnv != null && String(fromEnv).trim()) {
    return String(fromEnv).replace(/\/$/, "");
  }
  const fromConfig = Constants.expoConfig?.extra?.apiBase;
  if (fromConfig != null && String(fromConfig).trim()) {
    return String(fromConfig).replace(/\/$/, "");
  }
  /** Browser build: empty means “bundled demo only” — no backend required. */
  if (Platform.OS === "web") return "";
  if (Platform.OS === "android") return "http://10.0.2.2:8787";
  return "http://127.0.0.1:8787";
}
