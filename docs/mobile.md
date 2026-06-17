# OpenGUI Android

OpenGUI's Android app is built with Capacitor from the existing Vite frontend. It is not a separate codebase.

## Build locally

```bash
vp run mobile:sync
vp run mobile:build:debug
```

The debug APK is written to:

```txt
android/app/build/outputs/apk/debug/
```

To open the native project in Android Studio:

```bash
vp run mobile:open
```

## Runtime model

The release APK bundles the built Vite output from `dist` inside the app.

Android cannot run the Electron/Node sidecar, so the app connects to a remote or LAN **OpenGUI Backend** (an **API-only Backend** or **Combined Backend + Frontend** deployment).

Use in-app Workspace connection settings for the Backend URL and access token.
