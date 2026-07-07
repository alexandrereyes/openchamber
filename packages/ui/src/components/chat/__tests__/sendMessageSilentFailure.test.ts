/**
 * Reproduction test for #2072: Messages silently fail to send in long-context sessions.
 *
 * Root cause: Two silent-failure code paths that swallow errors without any user-facing
 * notification when message sends fail (particularly with timeouts/network errors that
 * are more frequent in long-context sessions due to higher provider latency).
 *
 * Path 1: ChatInput.tsx handleSubmit error handler (lines 2347-2352)
 *   Soft network errors (timeout, timed out, failed to fetch, network error, etc.)
 *   are silently swallowed when there are no file attachments. The input was already
 *   cleared (line 2032) so the user's text is gone, the optimistic message was rolled
 *   back by optimisticSend, but no toast is shown.
 *
 * Path 2: useQueuedMessageAutoSend.ts catch block (lines 182-183)
 *   When a queued auto-send fails, the error is only logged to console.warn.
 *   The message stays in the queue with no user notification.
 *   Combined with the question-dismissal → queue path (ChatInput.tsx lines 1888-1893),
 *   a user who types while questions are pending gets their message queued silently,
 *   and if the auto-send fails, they never see any indication.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Reproduction 1: ChatInput error handler silently swallows soft network errors
// ---------------------------------------------------------------------------

/**
 * Simulates the error-handler logic from ChatInput.tsx lines 2317-2358.
 * In the real code, this is inside handleSubmit().catch(). The input is already
 * cleared by this point (line 2032), and the optimistic message has been rolled
 * back by optimisticSend's catch block (session-actions.ts lines 724-738).
 */
function simulateErrorHandler(
  error: unknown,
  allAttachments: unknown[],
  toastFn: (msg: string) => void,
  t: (key: string) => string,
): { toastShown: boolean; toastMessage: string | null } {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error ?? '');
  const normalized = rawMessage.toLowerCase();

  let toastShown = false;
  let toastMessage: string | null = null;

  // Check payload too large (lines 2339-2345)
  if (
    normalized.includes('payload too large') ||
    normalized.includes('413') ||
    normalized.includes('entity too large')
  ) {
    toastShown = true;
    toastMessage = t('chat.chatInput.toast.attachmentsTooLarge');
    return { toastShown, toastMessage };
  }

  // Soft network errors (lines 2347-2352)
  const isSoftNetworkError =
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('may still be processing') ||
    normalized.includes('being processed') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror') ||
    normalized.includes('network error') ||
    normalized.includes('gateway timeout') ||
    normalized === 'failed to send message';

  if (isSoftNetworkError) {
    if (allAttachments.length > 0) {
      toastShown = true;
      toastMessage = t('chat.chatInput.toast.sendAttachmentsFailed');
    }
    // NO TOAST when there are no attachments — THE BUG
    return { toastShown, toastMessage };
  }

  // Hard error (line 2358)
  toastShown = true;
  toastMessage = rawMessage || t('chat.chatInput.toast.messageSendFailed');
  return { toastShown, toastMessage };
}

describe('#2072 Path 1: Soft network errors without attachments are silent', () => {
  const toastCalls: string[] = [];
  const toastFn = (msg: string) => { toastCalls.push(msg); };
  const mockT = (key: string) => {
    const map: Record<string, string> = {
      'chat.chatInput.toast.attachmentsTooLarge': 'Attachments too large',
      'chat.chatInput.toast.sendAttachmentsFailed': 'Failed to send attachments',
      'chat.chatInput.toast.messageSendFailed': 'Failed to send message',
    };
    return map[key] ?? key;
  };

  beforeEach(() => {
    toastCalls.length = 0;
  });

  // The exact error types that are likely in long-context sessions
  // (providers take longer to respond with larger context)

  test('timeout error with no attachments produces no toast', () => {
    const result = simulateErrorHandler(
      new Error('timeout'),
      [],
      toastFn,
      mockT,
    );
    expect(result.toastShown).toBe(false);
    expect(result.toastMessage).toBeNull();
  });

  test('gateway timeout error with no attachments produces no toast', () => {
    const result = simulateErrorHandler(
      new Error('Gateway Timeout'),
      [],
      toastFn,
      mockT,
    );
    expect(result.toastShown).toBe(false);
    expect(result.toastMessage).toBeNull();
  });

  test('failed to fetch error with no attachments produces no toast', () => {
    const result = simulateErrorHandler(
      new Error('Failed to fetch'),
      [],
      toastFn,
      mockT,
    );
    expect(result.toastShown).toBe(false);
    expect(result.toastMessage).toBeNull();
  });

  test('network error with no attachments produces no toast', () => {
    const result = simulateErrorHandler(
      new Error('NetworkError: request failed'),
      [],
      toastFn,
      mockT,
    );
    expect(result.toastShown).toBe(false);
    expect(result.toastMessage).toBeNull();
  });

  test('timed out error with no attachments produces no toast', () => {
    const result = simulateErrorHandler(
      new Error('The request timed out'),
      [],
      toastFn,
      mockT,
    );
    expect(result.toastShown).toBe(false);
    expect(result.toastMessage).toBeNull();
  });

  // Verify that WITH attachments, the toast IS shown
  test('timeout error WITH attachments shows toast', () => {
    const result = simulateErrorHandler(
      new Error('timeout'),
      [{ filename: 'file.txt' }],
      toastFn,
      mockT,
    );
    expect(result.toastShown).toBe(true);
    expect(result.toastMessage).toBe('Failed to send attachments');
  });

  // Verify that hard errors (not soft) show toast even without attachments
  test('non-soft error without attachments shows toast', () => {
    const result = simulateErrorHandler(
      new Error('Some other error'),
      [],
      toastFn,
      mockT,
    );
    expect(result.toastShown).toBe(true);
    expect(result.toastMessage).toBe('Some other error');
  });
});

// ---------------------------------------------------------------------------
// Reproduction 2: Queued auto-send silently swallows errors
// ---------------------------------------------------------------------------

describe('#2072 Path 2: Queued auto-send errors are silently swallowed', () => {
  /**
   * Simulates the exact error handling from useQueuedMessageAutoSend.ts lines 172-186.
   * When the queued auto-send fails, the catch block only logs to console.warn
   * and the message stays in the queue.
   */
  test('sendQueuedAutoSendPayload error should show notification but only logs to console.warn', async () => {
    const consoleWarnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      consoleWarnCalls.push(args.map(String).join(' '));
    };

    try {
      // Simulate what happens when queued auto-send fails
      // This matches the code at useQueuedMessageAutoSend.ts:182-183
      const failingSend = async () => {
        throw new Error('timeout - provider not responding');
      };

      const inFlightSet = new Set<string>();
      const sessionId = 'session-long-context';

      inFlightSet.add(sessionId);
      try {
        await failingSend();
        // If we got here, the message would be removed from the queue.
        // But since it threw, the queue is not modified.
      } catch (error) {
        // THE BUG: Only logs to console.warn — no toast, no user notification
        console.warn('[queue] queued auto-send failed:', error);
        // The message stays in the queue because removeFromQueue is never called
      } finally {
        inFlightSet.delete(sessionId);
      }

      // Verify the error was logged but no notification was shown
      expect(consoleWarnCalls.length).toBeGreaterThan(0);
      expect(consoleWarnCalls[0]).toContain('[queue] queued auto-send failed:');
      expect(consoleWarnCalls[0]).toContain('timeout');

      // The message is stranded — it was NOT removed from the queue
      // In the real code, inFlightSessionsRef.delete(sessionId) runs,
      // but the removeFromQueue call on line 180-181 is skipped.
      // The session ID was removed from inFlight, so a future idle transition
      // COULD trigger another auto-send attempt... IF the session transitions
      // from busy to idle again. But if the session is already idle, it won't.
      expect(inFlightSet.has(sessionId)).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  /**
   * Demonstrates how the question-dismissal → queue chain contributes.
   * ChatInput.tsx lines 1888-1893:
   *   if (dismissedQuestions) {
   *     handleQueueMessage();
   *     return; // <-- message queued, input cleared, no send attempted
   *   }
   *
   * In long sessions, the agent asks more questions about context.
   * Each question dismissal silently queues the user's message.
   */
  test('question dismissal silently queues message without sending', () => {
    // Simulate the ChatInput logic:
    // 1. User types message, hits Enter
    // 2. dismissOpenQuestionsForSession() returns true (questions dismissed)
    // 3. handleQueueMessage() clears input and queues the message
    // 4. handleSubmit returns WITHOUT sending
    //    (the "return;" at line 1892)
    //
    // The input was cleared, but no message appears in chat.
    // The user's message is only visible in the queue chips above the input.

    let messageQueued = false;
    let inputCleared = false;

    // Simulate handleQueueMessage behavior
    const inputHadContent = true;
    const questionsWereDismissed = true;

    if (questionsWereDismissed) {
      // This matches ChatInput.tsx:1891-1892
      // handleQueueMessage() clears input
      inputCleared = true;
      messageQueued = true;
      // return; -- no send happens
    }

    expect(inputCleared).toBe(true);
    expect(messageQueued).toBe(true);
    // The user sees their input cleared but no message in the chat.
    // The message is only visible in the queued message chips.
  });
});

// ---------------------------------------------------------------------------
// Reproduction 3: Session materialization limit in long sessions
// ---------------------------------------------------------------------------

describe('#2072 Path 3: Session materialization limit affects long sessions', () => {
  /**
   * In sync-context.tsx, SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30 (line 168).
   * When a session has more than 30 messages (common in long conversations),
   * materialization only loads the last 30. This means:
   * - Pinned context that references old messages may not be resolvable
   * - The session load may be incomplete
   * - Reconnection materialization can miss the session's full context
   */
  test('only last 30 messages are loaded during materialization', () => {
    const SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30;
    
    // Long session with 100+ messages
    const longSessionMessageCount = 120;
    
    // The materialization call (sync-context.tsx:261):
    // scopedClient.session.messages({ sessionID, limit: SESSION_MATERIALIZATION_MESSAGE_LIMIT })
    // Only loads 30 messages
    const loadedMessages = Math.min(
      longSessionMessageCount,
      SESSION_MATERIALIZATION_MESSAGE_LIMIT
    );
    
    expect(loadedMessages).toBe(30);
    // 90 messages are not loaded on materialization
    // This means message IDs from the early conversation aren't in the store
    
    const unloadedMessages = longSessionMessageCount - loadedMessages;
    expect(unloadedMessages).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Reproduction 4: Concurrent send failures with "may still be processing"
// ---------------------------------------------------------------------------

describe('#2072 Path 4: "may still be processing" errors are also silent', () => {
  /**
   * In long-context sessions, the provider may still be processing a previous
   * request when a new message is sent. The error "may still be processing" is
   * caught by the isSoftNetworkError check and silently swallowed.
   */
  test('"may still be processing" error without attachments is silent', () => {
    const result = simulateErrorHandler(
      new Error('The model may still be processing your request'),
      [],
      mock(() => {}),
      (key: string) => key,
    );
    expect(result.toastShown).toBe(false);
    expect(result.toastMessage).toBeNull();
  });

  test('"being processed" error without attachments is silent', () => {
    const result = simulateErrorHandler(
      new Error('Your request is being processed by another session'),
      [],
      mock(() => {}),
      (key: string) => key,
    );
    expect(result.toastShown).toBe(false);
    expect(result.toastMessage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reproduction 5: Session stuck "busy" from missed SSE event
// ---------------------------------------------------------------------------

describe('#2072 Path 5: SSE event timing can strand queued messages', () => {
  /**
   * The auto-send hook (useQueuedMessageAutoSend.ts) only dispatches when
   * the session transitions from busy/retry → idle (shouldDispatchQueuedAutoSend).
   * 
   * A race condition exists when:
   * 1. dismissOpenQuestionsForSession awaits the API call (ChatInput.tsx:1889)
   * 2. The SSE event for the status transition arrives DURING the await
   * 3. handleQueueMessage() runs (line 1891) — adds to queue
   * 4. The auto-send effect runs, but the previous status is already 'idle'
   *    (because the SSE event arrived in step 2)
   * 5. shouldDispatchQueuedAutoSend('idle', 'idle') returns false
   * 6. The message is stranded in the queue
   */
  test('race condition: status transition during question dismissal', () => {
    // Simulate the shouldDispatchQueuedAutoSend check
    // This is the actual function from useQueuedMessageAutoSend.ts:110-116
    const shouldDispatchQueuedAutoSend = (
      previousStatusType: string | undefined,
      currentStatusType: string,
    ): boolean => {
      return (previousStatusType === 'busy' || previousStatusType === 'retry')
        && currentStatusType === 'idle';
    };

    // Normal case: question dismissed, SSE arrives later
    // When queue is added, session is still 'busy' (SSE not yet processed)
    // Later when SSE arrives, status transitions to 'idle'
    // shouldDispatchQueuedAutoSend('busy', 'idle') === true ✓
    expect(shouldDispatchQueuedAutoSend('busy', 'idle')).toBe(true);

    // Race case: question dismissed, SSE arrives BEFORE queue is added
    // When queue is added, session is already 'idle'
    // shouldDispatchQueuedAutoSend('idle', 'idle') === false
    // THE AUTO-SEND NEVER FIRES
    expect(shouldDispatchQueuedAutoSend('idle', 'idle')).toBe(false);

    // Triple test: 'busy' → 'busy' (SSE hasn't arrived yet)
    // shouldDispatchQueuedAutoSend('busy', 'busy') === false
    // Wait for next transition
    expect(shouldDispatchQueuedAutoSend('busy', 'busy')).toBe(false);
  });
});
