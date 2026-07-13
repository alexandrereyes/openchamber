#!/usr/bin/env node

/**
 * Reproduction script for GitHub issue #2176
 *
 * Title: Windows desktop: clicking taskbar icon hides window to tray instead of
 *        minimizing to a taskbar button
 *
 * Root cause:
 * The `minimize` event handler in `createBrowserWindow()`
 * (packages/electron/main.mjs, line 2332-2337) calls
 * `event.preventDefault()` + `browserWindow.hide()` when
 * `shouldHideMainWindowToTray()` returns true.
 *
 * `shouldHideMainWindowToTray()` (line 247-253) returns true on Windows when
 * the system tray controller exists AND the `desktopMinimizeToTrayEnabled`
 * setting is `true`.
 *
 * The problem is that BOTH of these paths trigger the same `minimize` event:
 *   A. The custom titlebar minimize button (IPC `desktop_minimize_current_window`
 *      → `browserWindow.minimize()`)
 *   B. The Windows taskbar icon click (OS sends `WM_SYSCOMMAND SC_MINIMIZE`
 *      → Electron → `browserWindow.minimize()`)
 *
 * When minimize-to-tray is enabled, path A should hide to tray (desired), but
 * path B should still minimize normally (standard Windows behavior — the taskbar
 * button must remain visible so the user can click it to restore).
 *
 * Instead, path B is intercepted and the window is hidden (removing the taskbar
 * icon entirely), breaking the expected minimize/restore flow.
 *
 * This test validates the logic by simulating the minimize event path and
 * verifying that it leads to `hide()` instead of the default minimize.
 */

import { strictEqual } from 'node:assert';

console.log('=== Issue #2176 Reproduction ===\n');

// Simulate the critical code path

const simulateShouldHideMainWindowToTray = (platform, hasTray, settingEnabled, isMiniChat) => {
  if (platform !== 'win32') return false;
  if (!hasTray) return false;
  if (isMiniChat) return false;
  return settingEnabled === true;
};

const simulateMinimizeHandler = (shouldHideToTray) => {
  // Returns what action the handler takes:
  //   'hide'    → event.preventDefault() + browserWindow.hide()
  //   'default' → return (allow default minimize)
  if (shouldHideToTray) return 'hide';
  return 'default';
};

// Scenario 1: Windows, tray exists, setting OFF → should minimize normally
console.log('Scenario 1: Windows, tray exists, minimize-to-tray OFF');
{
  const hide = simulateShouldHideMainWindowToTray('win32', true, false, false);
  const action = simulateMinimizeHandler(hide);
  strictEqual(action, 'default', 'FAIL: Window should minimize normally');
  console.log('  ✓ Taskbar click → window minimizes (taskbar button stays)');
}

// Scenario 2: Windows, tray exists, setting ON → minimize intercepted, hides to tray
console.log('Scenario 2: Windows, tray exists, minimize-to-tray ON');
{
  const hide = simulateShouldHideMainWindowToTray('win32', true, true, false);
  const action = simulateMinimizeHandler(hide);
  strictEqual(action, 'hide', 'FAIL: Window should hide to tray (setting is on)');
  console.log('  ✓ minimize button in titlebar → hides to tray (good)');
  console.log('  ✗ taskbar icon click ALSO → hides to tray (BAD - bug!)');
}

// Scenario 3: macOS → never hides to tray on minimize
console.log('Scenario 3: macOS');
{
  const hide = simulateShouldHideMainWindowToTray('darwin', true, true, false);
  const action = simulateMinimizeHandler(hide);
  strictEqual(action, 'default', 'FAIL: Should minimize normally on macOS');
  console.log('  ✓ Taskbar/dock click → window minimizes normally');
}

// Demonstrate the shared event path
console.log('\n=== Root cause: shared minimize event path ===\n');
console.log(
  'Both the custom titlebar minimize button (desktop_minimize_current_window IPC)\n' +
  'and the Windows taskbar icon click go through:\n' +
  '  browserWindow.minimize() → minimize event → handler\n' +
  '\nThe handler at packages/electron/main.mjs:2332 cannot distinguish between\n' +
  'the two sources. When desktopMinimizeToTrayEnabled is true, BOTH paths call\n' +
  'event.preventDefault() + browserWindow.hide(), which:\n' +
  '  1. Prevents the normal minimize (SW_MINIMIZE → taskbar button stays)\n' +
  '  2. Hides the window (SW_HIDE → taskbar button disappears)\n' +
  '\nThis breaks the standard Windows taskbar minimize/restore flow.\n'
);

console.log('=== Verification complete ===');
