# OpenGUI Android

OpenGUI's Android app is built with Capacitor from the existing Vite frontend. It is not a separate codebase.

## Build locally

```bash
pnpm run mobile:sync
pnpm run mobile:build:debug
```

The debug APK is written to:

```txt
android/app/build/outputs/apk/debug/
```

To open the native project in Android Studio:

```bash
pnpm run mobile:open
```

## Runtime model

The release APK bundles the built Vite output from `dist` inside the app.

Android cannot run the Electron/Node sidecar, so the app connects to a remote or LAN **OpenGUI Backend** (an **API-only Backend** or **Combined Backend + Frontend** deployment).

Use in-app Workspace connection settings for the Backend URL and access token.

## Safe areas (Android and iOS)

The web build uses `viewport-fit=cover` in `src/index.html`. Layout insets come from shared CSS variables on `html` in `styles/globals.css`:

- `--app-safe-*` resolves `var(--safe-area-inset-*, env(safe-area-inset-*, 0px))`.
- On Android, Capacitor’s **SystemBars** plugin (`insetsHandling: "css"` in `capacitor.config.ts`) injects `--safe-area-inset-*` when WebView `env()` values are wrong or missing.
- On iOS, `env(safe-area-inset-*)` is used when injection is not present.

The main column title bar, prompt footer, fixed sidebar, and mobile sidebar sheet each apply these tokens locally. Do not add fixed pixel offsets for status or navigation bars.

## Android back navigation

The hardware back button and predictive back gesture are handled in the web layer via `@capacitor/app` (`src/shell/useMobileBackButton.ts`). Default Capacitor behavior (finishing the activity) is disabled in `capacitor.config.ts` (`App.disableBackButtonHandler`).

Back walks the in-app UI stack (dialogs, mobile sidebar sheet, settings, setup wizard steps, and similar). On the main chat screen, press back twice within two seconds to exit; a toast reminds you between presses.
