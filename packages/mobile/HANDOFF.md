# OpenChamber Mobile Handoff

This handoff summarizes the mobile app work completed in this worktree and the current local machine state for continuing native iOS/Android iteration.

## What Is In Place

- `packages/mobile` is now a Capacitor workspace package.
- The mobile package packages the existing hosted mobile web entry, not the desktop app root.
- `packages/mobile/scripts/prepare-web-assets.mjs` copies `packages/web/dist` into `packages/mobile/dist` and rewrites `mobile.html` to `index.html`, so Capacitor launches `MobileApp` directly.
- Native Capacitor projects have been generated under:
  - `packages/mobile/ios`
  - `packages/mobile/android`
- Generated native ignores exclude copied web assets, Pods, Gradle outputs, APKs, and local SDK paths.
- Root package scripts expose mobile build/sync/simulator commands.
- The dedicated mobile renderer no longer uses the web `SessionAuthGate`; native mobile owns its own connection onboarding flow.
- The native mobile connection flow supports server URL entry, password unlock for locked servers, client-token storage, saved connections, and an `Instances` management sheet.
- Mobile connection onboarding and `Instances` are Capacitor-only. Hosted `mobile.html` in a normal browser does not expose them.
- Server CORS now allows packaged/mobile origins such as `capacitor://localhost` plus local dev origins like `http://127.0.0.1:<port>`.

## Key Commands

From the repo root:

```sh
bun run mobile:build
bun run mobile:sync
bun run mobile:build:android:debug
bun run mobile:build:ios:simulator
```

iOS simulator helpers:

```sh
bun run mobile:sim:boot
bun run mobile:sim:install
bun run mobile:sim:launch
bun run mobile:sim:run
bun run mobile:sim:serve
bun run mobile:sim:list
bun run mobile:sim:kill
```

`packages/mobile/scripts/with-mobile-env.mjs` sets local defaults for:

- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
- `JAVA_HOME=/opt/homebrew/opt/openjdk@21`
- `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`
- `ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools`

Override these env vars if continuing on another machine.

## Local Machine Tooling State

The Mac has:

- Xcode 26.5 at `/Applications/Xcode.app`.
- Homebrew installed.
- `openjdk@17` installed.
- `openjdk@21` installed and used for Android Gradle builds.
- CocoaPods installed.
- Android command-line tools installed at `/opt/homebrew/share/android-commandlinetools`.
- Android SDK licenses accepted.
- Android SDK packages installed: `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`; Gradle also installed `build-tools;34.0.0` during build.

System `xcode-select` still points at Command Line Tools. The project scripts avoid this by setting `DEVELOPER_DIR` for mobile commands.

## Verified Builds

These commands were verified successfully:

```sh
bun run mobile:sync
bun run mobile:build:android:debug
bun run mobile:build:ios:simulator
bun run type-check:mobile
bun run lint:mobile
```

Known build warnings are inherited from the web build: KaTeX font URL resolution warnings, `onnxruntime-web` eval warning, dynamic/static import chunk warnings, and large chunk warnings. They did not fail the build.

## serve-sim Status

`serve-sim` was cloned locally to:

```txt
/Users/btriapitsyn/projects/serve-sim
```

`serve-sim` was added as a dev dependency of `packages/mobile` and is currently at npm latest verified during the session:

```txt
0.1.43
```

OpenChamber-specific agent guidance was added at:

```txt
.agents/skills/serve-sim/SKILL.md
```

`AGENTS.md` now maps iOS Simulator / `serve-sim` work to that skill.

The simulator preview was tested with:

```sh
bun run mobile:sim:run
serve-sim --host 0.0.0.0 -p 3200
```

The app launched in the iOS Simulator and raw MJPEG stream produced bytes from:

```txt
http://127.0.0.1:3100/stream.mjpeg
```

However, the browser preview UI on the phone showed:

```txt
Stream is not producing frames. The simulator may have stopped — try reconnecting.
```

After testing, all `serve-sim` helper/preview processes were stopped with `bun run mobile:sim:kill` and direct port checks confirmed `127.0.0.1:3100` and `127.0.0.1:3200` were no longer serving.

Likely follow-up: investigate `serve-sim` preview behavior on macOS 27 beta / Xcode 26.5. The raw stream working suggests the issue may be preview UI reconnect/state handling or beta OS compatibility rather than app build/install.

## Simulator Device Note

The available iOS simulator set is iOS 26.5. The default simulator helper uses:

```txt
iPhone 17 Pro
```

The earlier default `iPhone 16 Pro` was not available on this machine.

## Product/Architecture State

This work now includes the first mobile connection/auth shell, but still does not implement QR scanning, secure native storage, push notifications, biometrics, deep links, or native lifecycle handling.

Current mobile connection behavior:

- If no runtime is connected in Capacitor, the app shows a connect screen instead of the web UI auth error.
- A server URL can be entered manually.
- If the server is password-protected, the app prompts for the password and requests an issued client token.
- Saved instances are stored in browser/WebView local storage under the mobile connections key.
- The overflow menu has a Capacitor-only `Instances` sheet for adding, editing, deleting, and switching saved instances.
- Deleting the active instance resets the active runtime and returns the app to the connect screen.

Remaining production hardening:

- Move saved instance tokens from local storage to native secure storage.
- Implement QR pairing and camera permission flow.
- Add a first-class server-side pairing/token issuance route instead of relying on manual URL/password entry.
- Add explicit logout/revoke-token behavior.
- Add native lifecycle/back-button/status-bar/keyboard handling.

Next useful product step after simulator streaming is stable:

- Define the remote packaged-client auth token model.
- Keep inspecting the mobile import graph and bundle size; current mobile graph still includes heavy shared chunks.
