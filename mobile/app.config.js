/** @type {import('expo/config').ExpoConfig} */
export default {
  name: "Flightpath",
  slug: "flightpath-concept",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  scheme: "flightpath",
  ios: {
    bundleIdentifier: "com.flightpath.concept",
    supportsTablet: true,
  },
  android: {
    package: "com.flightpath.concept",
    adaptiveIcon: {
      backgroundColor: "#1a1a2e",
    },
  },
  plugins: ["expo-router"],
  extra: {
    /** Set EXPO_PUBLIC_API_BASE=http://YOUR_LAN_IP:8787 for a physical device */
    apiBase: process.env.EXPO_PUBLIC_API_BASE || "",
  },
};
