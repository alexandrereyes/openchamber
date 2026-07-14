/**
 * Reproduction test for issue #2225: Xiaomi 14 cannot launch camera to scan QR code.
 *
 * This test analyzes the QR scan flow and identifies potential failure modes
 * that could prevent the camera from opening on Xiaomi 14.
 *
 * Key findings:
 * 1. The scan button is only visible when `window.Capacitor.Plugins.BarcodeScanner`
 *    exists with a `scan` method (native Capacitor app only, NOT PWA/web).
 * 2. The `cancelled` status (returned when scan produces no barcode) has NO user
 *    feedback — the button silently re-enables without any error message.
 * 3. The native Android `scan()` method calls `GmsBarcodeScanner.startScan()` which
 *    uses Google Play Services' Code Scanner. On Xiaomi 14's HyperOS, this can fail
 *    if Google Play Services has restrictions or if the module isn't fully installed.
 * 4. The plugin independently checks module availability inside the native scan()
 *    method, rejecting with "module not available" if unavailable. Our JS retry
 *    handles this (3 attempts with 600ms delays).
 */

import { describe, expect, test, mock } from 'bun:test';

import { scanConnectionQr, isQrScanSupported, parseConnectionPayload } from './mobileQrScan';

interface BarcodeScannerPlugin {
  requestPermissions?: () => Promise<{ camera?: string } | undefined>;
  scan?: (options?: { formats?: string[] }) => Promise<{ barcodes?: Array<{ rawValue?: string; displayValue?: string }> } | undefined>;
  isGoogleBarcodeScannerModuleAvailable?: () => Promise<{ available?: boolean } | undefined>;
  installGoogleBarcodeScannerModule?: () => Promise<void>;
  addListener?: (
    event: string,
    cb: (info: { state?: number }) => void,
  ) => Promise<{ remove: () => void }>;
}

function setupMockCapacitor(plugin: BarcodeScannerPlugin): void {
  (globalThis as any).window = {};
  (window as any).setTimeout = setTimeout;
  (window as any).Capacitor = {
    getPlatform: () => 'android',
    Plugins: { BarcodeScanner: plugin },
  };
}

function createPlugin(overrides?: Partial<BarcodeScannerPlugin>): BarcodeScannerPlugin {
  return {
    requestPermissions: () => Promise.resolve({ camera: 'granted' }),
    scan: () => Promise.resolve({ barcodes: [{ rawValue: 'https://example.com' }] }),
    isGoogleBarcodeScannerModuleAvailable: () => Promise.resolve({ available: true }),
    installGoogleBarcodeScannerModule: () => Promise.resolve(),
    addListener: () => Promise.resolve({ remove: () => {} }),
    ...overrides,
  };
}

describe('Issue #2225: QR scan camera not opening on Xiaomi 14', () => {
  // ------------------------------------------------------------------
  // Platform detection — scan button visibility depends on Capacitor
  // ------------------------------------------------------------------
  test('isQrScanSupported returns false when Capacitor is absent (PWA/web scenario)', () => {
    (globalThis as any).window = {};
    expect(isQrScanSupported()).toBe(false);
  });

  test('isQrScanSupported returns false when plugin has no scan method', () => {
    (globalThis as any).window = {};
    (window as any).Capacitor = { Plugins: { BarcodeScanner: { } } };
    expect(isQrScanSupported()).toBe(false);
  });

  test('isQrScanSupported returns true when native Capacitor plugin is available', () => {
    setupMockCapacitor(createPlugin());
    expect(isQrScanSupported()).toBe(true);
  });

  // ------------------------------------------------------------------
  // Permission failures
  // ------------------------------------------------------------------
  test('scan returns permission-denied when camera permission is denied', async () => {
    setupMockCapacitor(createPlugin({
      requestPermissions: () => Promise.resolve({ camera: 'denied' }),
    }));
    const result = await scanConnectionQr();
    expect(result.status).toBe('permission-denied');
  });

  test('scan returns permission-denied when permission state is prompt', async () => {
    setupMockCapacitor(createPlugin({
      requestPermissions: () => Promise.resolve({ camera: 'prompt' }),
    }));
    const result = await scanConnectionQr();
    expect(result.status).toBe('permission-denied');
  });

  // ------------------------------------------------------------------
  // Silent failure: scan returns empty/no result → { status: 'cancelled' }
  // In MobileApp.tsx, 'cancelled' is handled as: case 'cancelled': default: break;
  // → NO error shown to the user. This is the most likely bug scenario.
  // ------------------------------------------------------------------
  test('SILENT FAILURE: scan() returning undefined shows no user error', async () => {
    setupMockCapacitor(createPlugin({
      // Plugin.scan() might return undefined on Xiaomi 14 if the Google
      // Code Scanner fails to initialize or returns nothing
      scan: () => Promise.resolve(undefined) as any,
    }));
    const result = await scanConnectionQr();
    expect(result.status).toBe('cancelled');
    // In MobileApp.tsx: case 'cancelled': default: break; → no error set
  });

  test('SILENT FAILURE: scan() returning empty barcodes array shows no error', async () => {
    setupMockCapacitor(createPlugin({
      scan: () => Promise.resolve({ barcodes: [] }),
    }));
    const result = await scanConnectionQr();
    expect(result.status).toBe('cancelled');
  });

  test('SILENT FAILURE: scan() returning barcode with empty value shows no error', async () => {
    setupMockCapacitor(createPlugin({
      scan: () => Promise.resolve({ barcodes: [{ rawValue: '', displayValue: '' }] }),
    }));
    const result = await scanConnectionQr();
    expect(result.status).toBe('cancelled');
  });

  // ------------------------------------------------------------------
  // Error handling — module unavailable retry logic
  // ------------------------------------------------------------------
  test('scan retries on "module not available" error from native scan()', async () => {
    let callCount = 0;
    setupMockCapacitor(createPlugin({
      scan: () => {
        callCount++;
        if (callCount < 2) {
          return Promise.reject(new Error('The Google Barcode Scanner Module is not available.'));
        }
        return Promise.resolve({ barcodes: [{ rawValue: 'https://example.com' }] });
      },
    }));
    const result = await scanConnectionQr();
    expect(result.status).toBe('ok');
    expect(callCount).toBe(2);
  });

  test('max 3 retries before giving up on persistent module unavailable', async () => {
    let callCount = 0;
    setupMockCapacitor(createPlugin({
      scan: () => {
        callCount++;
        return Promise.reject(
          new Error('The Google Barcode Scanner Module is not available. You must install it first.'),
        );
      },
    }));
    const result = await scanConnectionQr();
    expect(result.status).toBe('failed');
    expect(callCount).toBe(3);
  });

  // ------------------------------------------------------------------
  // The Native scan() flow (from BarcodeScannerPlugin.java):
  //   1. Checks isGoogleBarcodeScannerModuleAvailable()
  //   2. If not available → rejects with "module not available"
  //   3. If available → calls GmsBarcodeScanner.startScan()
  //      which opens a full-screen camera overlay via Google Play Services
  //
  // On Xiaomi 14, possible failure points:
  //   A. Google Play Services restricted (HyperOS) → module check fails
  //   B. Camera permission blocked by HyperOS → requestPermissions fails
  //   C. GmsBarcodeScanner fails to initialize camera → resolves with no barcode
  //   D. GmsBarcodeScanner Activity blocked → resolves with no barcode
  // ------------------------------------------------------------------

  test('parseConnectionPayload handles valid inputs', () => {
    expect(parseConnectionPayload('http://192.168.1.100:2606')).toEqual({ url: 'http://192.168.1.100:2606' });
    expect(parseConnectionPayload('  https://server.example.com ')).toEqual({ url: 'https://server.example.com' });
  });

  test('parseConnectionPayload rejects invalid inputs', () => {
    expect(parseConnectionPayload('')).toBeNull();
    expect(parseConnectionPayload('hello world')).toBeNull();
    expect(parseConnectionPayload('openchamber://connect')).toBeNull();
  });
});
