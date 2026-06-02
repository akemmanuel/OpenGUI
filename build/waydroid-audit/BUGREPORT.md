# OpenGUI Android/Waydroid Bug Report

Date: 2026-06-01
Build: debug APK `android/app/build/outputs/apk/debug/app-debug.apk`
Device: Waydroid x86_64, Android 13, WebView Chrome/138.0.7204.63
Package: `com.opengui.app`
Inspection method: ADB + WebView Chrome DevTools Protocol via local scripts, no `chrome://inspect`.

Artifacts:
- Screenshots/snapshots: `build/waydroid-audit/`
- Initial screenshot: `build/waydroid-audit/01_initial.png`
- CDP log events: `build/waydroid-audit/cdp-events.json`
- DOM snapshot: `build/waydroid-audit/01_initial.json`

## Summary

The APK launches and renders, but the Android experience is currently a desktop/web shell running inside Capacitor. The most important functional issue is that the app immediately tries to talk to a stale/unreachable backend (`http://192.168.100.10:3453`), resulting in permanent `Failed to fetch` UI state and repeated event stream errors. There are also modal/focus problems and Android-inappropriate desktop controls in Settings.

## Bugs Found

### 1. App boots into stale remote workspace and hard-fails with `Failed to fetch`

Severity: High

Observed:
- Initial UI shows workspace `asdasd` and main pane shows `Failed to fetch`.
- CDP network logs repeatedly show refused requests:
  - `http://192.168.100.10:3453/api/rpc`
  - `http://192.168.100.10:3453/api/events/v2`
  - `http://192.168.100.10:3453/api/projects`
- LocalStorage contains active workspace `ws_mpr8231r` pointing at `http://192.168.100.10:3453`.

Expected:
- Android app should either start in an onboarding/connect-workspace state, or detect unreachable backend and present a clear reconnect/edit/remove workspace action.
- It should not keep retrying a dead EventSource indefinitely without useful recovery UI.

Evidence:
- `build/waydroid-audit/01_initial.json`
- `build/waydroid-audit/cdp-events.json`
- `adb logcat` showed repeated `OpenGUI event stream error [object Event]`.

### 2. Event stream retry loop logs duplicate errors continuously

Severity: Medium/High

Observed:
- `api/events/v2` fails repeatedly with `net::ERR_CONNECTION_REFUSED`.
- Logcat shows paired duplicate messages every retry interval:
  - `OpenGUI event stream error [object Event]`
- Retry cadence expands, but errors continue while UI remains degraded.

Expected:
- One visible connection status with retry/backoff state.
- Avoid duplicate event stream subscriptions or duplicate logging.

Evidence:
- `build/waydroid-audit/cdp-events.json`
- logcat excerpts around `Capacitor/Console`.

### 3. Add Workspace modal does not block background navigation/interactions

Severity: High

Observed steps:
1. Tap/click top-bar `Add workspace`.
2. Add Workspace dialog opens.
3. Background/sidebar `Settings` remains interactable.
4. Settings page opens behind/under the modal while the modal remains mounted.

Observed DOM after this state contains both:
- Settings page content (`Back`, `Settings`, `General`, `Providers`, etc.)
- Active `[role=dialog]` Add Workspace modal

Expected:
- Modal should trap focus and make background inert.
- Background controls should not navigate or mutate state while modal is open.

Evidence:
- DevTools snapshot after repro showed one `[role=dialog]` plus Settings page text.

### 4. Android Settings exposes desktop-only controls

Severity: Medium

Observed in Android APK Settings:
- `File manager` command field
- `Terminal` command field
- `Desktop notifications`
- `Restart Agent Backends`

These are desktop/Electron-oriented concepts and appear in the Capacitor native Android shell.

Expected:
- Hide or adapt desktop-only settings in native Android.
- Use runtime policy to gate unsupported controls.

Evidence:
- Settings DOM snapshot after navigation.

### 5. Initial Android layout is desktop-first and poorly adapted to native mobile/tablet

Severity: Medium

Observed:
- Full desktop sidebar is rendered by default.
- Top bar and sidebar controls use small 24–32 px targets in several places (`Pin project`, project menu, top Add workspace).
- Main content mostly displays a desktop chat composer with no Android-specific onboarding/error recovery.

Expected:
- Native Android should have a mobile/tablet-specific navigation mode, larger touch targets, and connection/onboarding-first flow.

Evidence:
- `build/waydroid-audit/01_initial.png`
- Visible interactive rects in `build/waydroid-audit/01_initial.json`.

## Scripts Added

- `scripts/waydroid-adb-connect.sh` — verifies ADB transport is actually visible in `adb devices`.
- `scripts/inspect-waydroid-webview.mjs` — CDP inspection/evaluation/screenshot helper.
- `scripts/audit-waydroid-opengui.mjs` — launches app, collects screenshots, DOM snapshots, and CDP network/log errors.

Run audit:

```bash
node scripts/audit-waydroid-opengui.mjs
```

Inspect arbitrary JS:

```bash
node scripts/inspect-waydroid-webview.mjs "document.body.innerText"
```

## Recommended Fix Order

1. Fix native Android workspace/bootstrap behavior for unreachable/stale workspaces.
2. De-duplicate event stream subscriptions/logging and surface connection state.
3. Fix Add Workspace modal inert/focus trap behavior.
4. Gate desktop-only settings/actions behind Electron/desktop runtime checks.
5. Add Android-specific responsive/touch layout pass.
