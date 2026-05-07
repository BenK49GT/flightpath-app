import "react-native-gesture-handler";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#1a1a2e" }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: "#1a1a2e" },
            headerTintColor: "#eaeaea",
            headerTitleStyle: { fontWeight: "600" },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: "#1a1a2e" },
          }}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
