import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.opengui.app",
  appName: "OpenGUI",
  webDir: "dist",
  server: {
    cleartext: true,
    androidScheme: "http",
  },
};

export default config;
