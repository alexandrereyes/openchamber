import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Reproduction test for issue #2223
 *
 * Bug: "TypeError: Cannot read properties of undefined (reading 'postMessage')"
 * 
 * Root cause: In bridge.ts, getVSCodeAPI() calls acquireVsCodeApi() which may
 * return undefined in some scenarios (e.g., after extension update in Cursor IDE).
 * The function returns whatever acquireVsCodeApi() returns without null-checking,
 * so subsequent .postMessage() calls crash.
 *
 * Steps to reproduce:
 * 1. acquireVsCodeApi returns undefined (simulating webview context issue)
 * 2. sendBridgeMessageWithOptions is called
 * 3. getVSCodeAPI().postMessage(request) throws TypeError
 */

describe('reproduce issue #2223 - getVSCodeAPI crash', () => {
  // Track originals to restore after test
  const originalWindow = globalThis.window;
  const originalAcquire = (globalThis as Record<string, unknown>).acquireVsCodeApi;

  before(() => {
    // We need a non-null window for the bridge module's addEventListener calls
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: new EventTarget() as unknown as Window & typeof globalThis,
    });
  });

  after(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
  });

  test('sendBridgeMessageWithOptions crashes when acquireVsCodeApi returns undefined', async () => {
    // Set acquireVsCodeApi to return undefined (simulates the bug scenario)
    Object.defineProperty(globalThis, 'acquireVsCodeApi', {
      configurable: true,
      value: () => undefined,
    });

    // Import bridge with a cache-busting query param to get a fresh module instance
    const { sendBridgeMessageWithOptions } = await import(
      './bridge?repro-2223-' + Date.now()
    );

    // Calling sendBridgeMessageWithOptions triggers getVSCodeAPI().postMessage(request)
    // at line 125 of bridge.ts, which should crash because getVSCodeAPI() returned undefined.
    try {
      await sendBridgeMessageWithOptions('api:proxy', { path: '/test' });
      assert.fail('Expected TypeError but no error was thrown');
    } catch (err: unknown) {
      const error = err as Error;
      // The actual error: "Cannot read properties of undefined (reading 'postMessage')"
      assert.ok(
        error instanceof TypeError,
        `Expected TypeError but got ${error?.constructor?.name ?? typeof error}: ${error?.message ?? error}`,
      );
      assert.match(
        error.message,
        /Cannot read properties of undefined/,
        `Error message should mention reading from undefined but got: ${error.message}`,
      );
    }
  });
});
