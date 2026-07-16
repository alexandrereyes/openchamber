# Reproduction: iOS PWA bottom gap cuts off message box

**Issue:** [#2287](https://github.com/openchamber/openchamber/issues/2287)

## Summary

When the OpenChamber web app is installed as a PWA on iOS (Add to Home Screen), a dead band approximately the height of the status bar (44–54px) appears at the bottom of the screen, cutting off or partially hiding the message input field.

## Root Cause

The `<html>` and `<body>` elements use the Tailwind `h-full` class, which maps to `height: 100%`. With the combination of:

1. `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`
2. `viewport-fit=cover` in the viewport meta
3. `html, body { height: 100% }` (via `h-full`)

iOS offsets the entire view behind the status bar, but `height: 100%` on the body is measured against its containing block (the initial containing block = layout viewport), which does **not** account for the status bar offset. The body does not grow to fill the true visual viewport, leaving a "chin" gap at the bottom.

The app already uses `env(safe-area-inset-bottom)` and `100dvh` internally for components — this is specifically a root-level `<html>/<body>` height issue.

## Fix

Replace `h-full` (`height: 100%`) on `<html>` and `<body>` with `height: 100vh` (or `height: 100dvh`), while leaving inner containers on `100dvh`/`h-full` as they are.

### Affected files

| File | Lines | Current |
|------|-------|---------|
| `packages/web/index.html` | 2, 519–520 | `<html class="h-full">`, `<body class="h-full bg-background text-foreground">`, `<div id="root" class="h-full">` |
| `packages/web/mobile.html` | 2, 68–69 | `<html class="h-full">`, `<body class="h-full bg-background text-foreground">`, `<div id="root" class="h-full">` |
| `packages/web/mini-chat.html` | 2, 79–80 | `<html class="h-full">`, `<body class="h-full bg-background text-foreground">`, `<div id="root" class="h-full">` |

## How to reproduce

### On a real iOS device

1. Serve this directory: `npx serve .` or `python3 -m http.server 8080`.
2. Open the URL in iOS Safari.
3. Tap Share → Add to Home Screen.
4. Launch the PWA from the home screen.
5. Observe the "Current" panel: its message box is partially/fully hidden behind the bottom chin gap.
6. The "Fixed" panel shows the intended behavior with `height: 100vh`.

### Without a device

Open `repro.html` in any browser. The page simulates the iOS PWA viewport offset with a status bar overlay and a striped bottom-gap indicator. The left panel uses `height: 100%` (current bug) and the right panel uses `height: 100vh` (fix). In the left panel, notice the message box is pushed down behind the striped gap indicator.
