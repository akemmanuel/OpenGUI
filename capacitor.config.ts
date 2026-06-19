import type { CapacitorConfig } from "@capacitor/cli";

const devServerUrl = process.env.OPENGUI_CAPACITOR_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: "com.opengui.app",
  appName: "OpenGUI",
  webDir: "dist",
  server: {
    ...(devServerUrl ? { url: devServerUrl } : {}),
    cleartext: true,
    androidScheme: "http",
  },
  plugins: {
    App: {
      disableBackButtonHandler: true,
    },
    SystemBars: {
      insetsHandling: "css",
    },
  },
};

export default config;
