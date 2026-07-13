/**
 * Reproduction test for issue #2181:
 * TypeError: Cannot read properties of undefined (reading 'postMessage')
 *
 * This error occurs when `.postMessage` is accessed on an undefined value.
 * Two specific code paths can trigger this:
 *
 * Path A: window.parent.postMessage() in ChatContainer.tsx (line 615)
 *   The guard `window.parent === window` does NOT catch undefined parent.
 *   In standard browsers, window.parent is never undefined, but in
 *   non-standard or testing environments it can be.
 *
 * Path B: getVSCodeAPI().postMessage() via bridge.ts (lines 49,125,149,164)
 *   When acquireVsCodeApi() returns undefined, getVSCodeAPI() returns
 *   undefined and .postMessage() crashes.
 *
 * Path C: SessionEditorPanelProvider.ts (lines 430-443)
 *   entry.panel.webview.postMessage() without optional chaining.
 *   Unlike ChatViewProvider (which uses `this._view?.webview.postMessage()`),
 *   SessionEditorPanelProvider accesses `entry.panel.webview.postMessage()`
 *   directly. If the panel is disposed before the SSE callback fires,
 *   entry.panel.webview could be inaccessible.
 */

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

/**
 * Helper: check that the error is a TypeError about reading 'postMessage'
 * from undefined. Different JS engines format this error differently:
 * - V8 (Chrome/Node/VS Code): "Cannot read properties of undefined (reading 'postMessage')"
 * - JavaScriptCore (Safari/Bun): "undefined is not an object (evaluating 'x.postMessage')"
 */
const isPostMessageOnUndefinedError = (error: unknown): boolean => {
  if (!(error instanceof TypeError)) return false;
  const message = (error as Error).message;
  return (
    message.includes('postMessage') &&
    (message.includes('undefined') || message.includes('null'))
  );
};

describe('Issue #2181 - postMessage on undefined reproduction', () => {
  test('Path A: window.parent.postMessage crashes when parent is undefined', async () => {
    // The ChatContainer.tsx guard at line 592:
    //   if (typeof window === 'undefined' || window.parent === window) { return; }
    //
    // If window.parent is undefined:
    //   typeof window === 'undefined' -> false
    //   window.parent === window -> undefined === window -> false (!)
    //
    // The guard does NOT return early! Execution continues to line 615:
    //   window.parent.postMessage({ type: 'openchamber:chat-settings-request' }, ...)
    //   -> TypeError: Cannot read properties of undefined (reading 'postMessage')

    const mockWindowWithUndefinedParent = {
      location: { origin: 'http://localhost:3000' },
      addEventListener: () => {},
      parent: undefined as Window | undefined,
    } as unknown as Window & typeof globalThis;

    // Guard check fails to catch undefined parent
    const guardPasses = (win: typeof mockWindowWithUndefinedParent): boolean => {
      if (typeof win === 'undefined' || win.parent === win) {
        return true;
      }
      return false;
    };

    assert.equal(
      guardPasses(mockWindowWithUndefinedParent),
      false,
      'BUG: Guard does not catch undefined window.parent',
    );

    // The postMessage call that follows would crash
    try {
      (mockWindowWithUndefinedParent.parent as Window).postMessage(
        { type: 'openchamber:chat-settings-request' },
        mockWindowWithUndefinedParent.location.origin,
      );
      assert.fail('Expected a TypeError');
    } catch (error) {
      assert.ok(
        isPostMessageOnUndefinedError(error),
        `Expected TypeError about postMessage on undefined, got: ${error instanceof Error ? error.message : error}`,
      );
    }
  });

  test('Path B: getVSCodeAPI().postMessage crashes when acquireVsCodeApi() returns undefined', () => {
    // In bridge.ts line 13-18:
    //   function getVSCodeAPI(): VSCodeAPI {
    //     if (!vscodeApi) {
    //       vscodeApi = acquireVsCodeApi();
    //     }
    //     return vscodeApi;
    //   }
    //
    // If acquireVsCodeApi() returns undefined, getVSCodeAPI() returns
    // undefined, and callers crash when accessing .postMessage on it.

    let vscodeApi: { postMessage: (msg: unknown) => void } | null = null;

    // Simulate acquireVsCodeApi() returning undefined
    const acquireVsCodeApi = () => undefined as unknown as {
      postMessage: (msg: unknown) => void;
    };

    const getVSCodeAPI = (): { postMessage: (msg: unknown) => void } => {
      if (!vscodeApi) {
        vscodeApi = acquireVsCodeApi() as unknown as { postMessage: (msg: unknown) => void };
      }
      return vscodeApi as { postMessage: (msg: unknown) => void };
    };

    try {
      getVSCodeAPI().postMessage({ type: 'test' });
      assert.fail('Expected a TypeError');
    } catch (error) {
      assert.ok(
        isPostMessageOnUndefinedError(error),
        `Expected TypeError about postMessage on undefined, got: ${error instanceof Error ? error.message : error}`,
      );
    }
  });

  test('Path C: SessionEditorPanelProvider unguarded entry.panel.webview.postMessage crashes after disposal', () => {
    // In SessionEditorPanelProvider.ts, SSE callbacks use:
    //   entry.panel.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk });
    //
    // WITHOUT optional chaining (unlike ChatViewProvider which uses
    // `this._view?.webview.postMessage(...)`).
    //
    // After panel disposal, entry.panel.webview could become inaccessible.
    // When it's undefined, the unguarded call crashes.

    const disposedEntry = {
      panel: {
        webview: undefined as { postMessage: (msg: unknown) => boolean } | undefined,
      },
    };

    try {
      // This mirrors the direct access in SessionEditorPanelProvider
      (disposedEntry.panel.webview as { postMessage: (msg: unknown) => boolean }).postMessage({
        type: 'api:sse:end',
        streamId: 'sse_1',
      });
      assert.fail('Expected a TypeError');
    } catch (error) {
      assert.ok(
        isPostMessageOnUndefinedError(error),
        `Expected TypeError about postMessage on undefined, got: ${error instanceof Error ? error.message : error}`,
      );
    }
  });
});
