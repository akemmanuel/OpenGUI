# OpenGUI Android

The Android shell is a Capacitor package of the shared React Frontend. It is a client of an
authenticated **Remote Host**: it does not run Node.js, a phone-local Harness, model tools, or shell
commands. Projects, Sessions, credentials, and execution remain on the Host.

## Connect to a Host

1. Deploy a `combined` or `api-only` Remote Host and verify `https://host.example/api/health` from
   the phone's network. Use HTTPS outside a trusted LAN.
2. In OpenGUI, open the Workspace switcher in the title bar and choose **Add workspace**.
3. Enter a name and the Host origin (for example `https://host.example`, without an `/api` suffix).
   The token field is optional for normal Account login; it accepts a named Host API key for
   automation/advanced use or a bootstrap token only before first-owner setup.
4. If the Host is new, create its owner Account. Otherwise sign in or accept an invite. Account
   authentication is stored with that Workspace.
5. Choose a Project path shared by the Host owner, select an entitled model offering, and create a
   Session. A mobile Project refers to a directory on the Remote Host, not phone storage.

If connection fails, check the exact origin, TLS certificate trust, reverse-proxy Web/SSE support,
Host CORS origin, Account/invite state, and path/model grants. Never expose Docker host-control mode
directly to the public internet.

## Build locally

Requirements are Node.js 22.19+ (release CI uses Node.js 24), pnpm 11.8.0, Android SDK, and Java 21.

```bash
pnpm install --frozen-lockfile
pnpm run mobile:sync
pnpm run mobile:build:debug
```

The debug APK is written under `android/app/build/outputs/apk/debug/`. Open Android Studio with:

```bash
pnpm run mobile:open
```

`pnpm run mobile:build:release` builds the release variant. The repository currently signs that
variant with a generated debug keystore so CI can produce an installable candidate; configure a
protected production signing key before any store or stable production release.

## Runtime and navigation

The APK bundles `dist`; it does not depend on the Web shell being served by the Host. It still
requires network access to the Host API and event stream. Test reconnect, send/follow-up/abort,
uploads, and background/foreground behavior against the candidate Host.

The hardware back button and predictive-back gesture walk the in-app UI stack. On the main chat
screen, press back twice within two seconds to exit.

## Safe areas

The shared web build uses `viewport-fit=cover` and `interactive-widget=resizes-content`. Layout
insets come from `--app-safe-*` variables in `styles/globals.css`; Capacitor SystemBars injects the
underlying values on Android. Do not add fixed status/navigation-bar offsets. iOS safe-area CSS is
kept compatible, but no iOS project or release artifact is included in this release candidate.
