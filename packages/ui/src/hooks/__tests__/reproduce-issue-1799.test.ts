/**
 * Reproduction test for issue #1799:
 * Queued messages are not auto-dispatched after `/compact`.
 *
 * Root cause:
 *   `shouldDispatchQueuedAutoSend` requires a `busy`/`retry` → `idle` session-status
 *   transition.  Normal message sending sets the session status to `busy` optimistically
 *   (submit.ts:67-73) and the server later flips it to `idle`, producing the edge.
 *   The `/compact` command calls `opencodeClient.summarizeSession(...)` without any
 *   optimistic status update, so the session stays `idle` throughout — no transition,
 *   no auto-dispatch.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks for stores the hook depends on
// ---------------------------------------------------------------------------

const sendMessageCalls: unknown[][] = [];
const sessionAbortFlags = new Map<string, { timestamp: number }>();

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      getVisibleAgents: () => [],
    }),
  },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
        return Promise.resolve();
      },
      sessionAbortFlags,
    }),
  },
}));

// These stores are subscribed by the hook via zustand selectors.
// We'll poke values directly in tests.
const queuedMessagesState = { current: {} as Record<string, unknown[]> };
const sessionStatusState = { current: {} as Record<string, { type: string }> };

mock.module('@/stores/messageQueueStore', () => ({
  useMessageQueueStore: (selector: (s: unknown) => unknown) =>
    selector({ queuedMessages: queuedMessagesState.current }),
}));

// The hook uses `useDirectorySync` which selects `session_status`.
// We give it a minimal mock that returns our controllable state.
import { create } from 'zustand';

type MockSyncState = { session_status: Record<string, { type: string }> };
const useMockSync = create<MockSyncState>(() => ({
  session_status: {},
}));

// We'll override the actual import path with a local proxy.
// Since we can't easily mock `@/sync/sync-context` for `useDirectorySync`,
// we test the pure logic functions directly — the effect's dispatch logic
// is entirely driven by `shouldDispatchQueuedAutoSend` which IS pure.

import {
  shouldDispatchQueuedAutoSend,
} from '../useQueuedMessageAutoSend';

describe('Issue #1799 — Queued messages not auto-dispatched after /compact', () => {
  beforeEach(() => {
    sendMessageCalls.length = 0;
    sessionAbortFlags.clear();
    queuedMessagesState.current = {};
    sessionStatusState.current = {};
  });

  describe('shouldDispatchQueuedAutoSend', () => {
    // --- What works (normal assistant turn) ---
    test('fires on busy → idle (normal assistant turn)', () => {
      expect(shouldDispatchQueuedAutoSend('busy', 'idle')).toBe(true);
    });

    test('fires on retry → idle (retry recovery)', () => {
      expect(shouldDispatchQueuedAutoSend('retry', 'idle')).toBe(true);
    });

    // --- What fails (/compact lifecycle) ---
    test('does NOT fire on idle → idle (compaction never sets busy)', () => {
      // This is exactly what happens during /compact:
      // The session stays idle the whole time because summarization
      // does not optimistically set status to 'busy'.
      expect(shouldDispatchQueuedAutoSend('idle', 'idle')).toBe(false);
    });

    test('does NOT fire on undefined → idle (initial render during compaction)', () => {
      // On the first render where the hook observes the session,
      // previousStatus is undefined. If the session is idle (compaction
      // never set busy), no dispatch occurs.
      expect(shouldDispatchQueuedAutoSend(undefined, 'idle')).toBe(false);
    });

    test('does NOT fire on idle → busy (compaction not setting busy at all)', () => {
      // Even if we somehow got to 'busy', we'd need busy→idle, not idle→busy
      expect(shouldDispatchQueuedAutoSend('idle', 'busy')).toBe(false);
    });
  });

  describe('Simulated compaction lifecycle', () => {
    test('queued message is NOT dispatched when status stays idle throughout', () => {
      // Simulate: session starts idle, compaction runs, status stays idle
      // (this mirrors what happens during `/compact`)
      let previousStatus: string | undefined = undefined;

      // Render 1: no previous status, current idle → no dispatch
      expect(shouldDispatchQueuedAutoSend(
        previousStatus as 'busy' | 'retry' | 'idle' | undefined,
        'idle',
      )).toBe(false);
      previousStatus = 'idle';

      // Render 2: previous idle, current idle (compaction still running, status still idle)
      expect(shouldDispatchQueuedAutoSend(
        previousStatus as 'busy' | 'retry' | 'idle' | undefined,
        'idle',
      )).toBe(false);
      previousStatus = 'idle';

      // Render 3: previous idle, current idle (compaction finished, but no transition)
      expect(shouldDispatchQueuedAutoSend(
        previousStatus as 'busy' | 'retry' | 'idle' | undefined,
        'idle',
      )).toBe(false);
      // → Message remains queued, never auto-sent
    });

    test('queued message IS dispatched after normal assistant turn (busy → idle)', () => {
      // Simulate: session goes from 'busy' (assistant working) to 'idle' (done)
      let previousStatus: string | undefined = undefined;

      // Render 1: no previous, current idle → no dispatch
      expect(shouldDispatchQueuedAutoSend(
        previousStatus as 'busy' | 'retry' | 'idle' | undefined,
        'idle',
      )).toBe(false);
      previousStatus = 'idle';

      // Render 2: user sends a message → status becomes busy
      expect(shouldDispatchQueuedAutoSend(
        previousStatus as 'busy' | 'retry' | 'idle' | undefined,
        'busy',
      )).toBe(false);
      previousStatus = 'busy';

      // Render 3: assistant finishes → busy → idle → DISPATCH!
      expect(shouldDispatchQueuedAutoSend(
        previousStatus as 'busy' | 'retry' | 'idle' | undefined,
        'idle',
      )).toBe(true);
      // → Message is auto-sent ✓
    });
  });
});
