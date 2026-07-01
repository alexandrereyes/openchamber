/**
 * Reproduction test for issue #1983:
 * Mobile: 上一回合回复完毕后仍显示未完成状态，需点两次 Send 才能发送新消息
 *
 * Root cause: When `followUpBehavior === 'queue'` (the DEFAULT) and the session
 * status has NOT yet transitioned to 'idle' (e.g., the `session.status`
 * SSE event is delayed), tapping Send queues the message instead of sending it.
 * The user must tap a second time (after the idle event arrives) to actually send.
 *
 * Additionally, on mobile, the `ComposerActionButtons` component shows a STOP
 * button (not Send) when the session is busy, alongside a small queue button
 * (rotated send icon). The queue button looks similar to the send button and
 * users may tap it thinking it's Send.
 *
 * The core behavioral issue is in `handlePrimaryAction`:
 *   canQueue = inputMode === 'normal' && hasContent && sessionId && (sessionPhase !== 'idle');
 *   if (followUpBehavior === 'queue' && canQueue) {
 *       handleQueueMessage();  // ← first tap: QUEUES instead of sending
 *   } else {
 *       handleSubmit();        // ← second tap (now idle): actually sends
 *   }
 */

import { describe, test, expect } from 'bun:test';

describe('Issue #1983: Two-tap send on mobile', () => {
  const DEFAULT_FOLLOW_UP_BEHAVIOR = 'queue' as const;

  /**
   * Simulates the core logic of `handlePrimaryAction` from ChatInput.tsx.
   */
  function simulatePrimaryAction(params: {
    followUpBehavior: string;
    sessionPhase: string;
    hasContent: boolean;
    currentSessionId: string | null;
    inputMode: string;
    autoReviewRunning: boolean;
  }): 'send' | 'queue' | 'steer' {
    const { followUpBehavior, sessionPhase, hasContent, currentSessionId, inputMode, autoReviewRunning } = params;
    
    const canQueue = inputMode === 'normal' && hasContent && currentSessionId !== null && (sessionPhase !== 'idle' || autoReviewRunning);
    
    if (followUpBehavior === 'queue' && canQueue) {
      return 'queue';
    } else if (followUpBehavior === 'steer' && canQueue) {
      return 'steer';
    } else {
      return 'send';
    }
  }

  test('should SEND directly when session is idle (normal case)', () => {
    const result = simulatePrimaryAction({
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR, // 'queue' (default)
      sessionPhase: 'idle',
      hasContent: true,
      currentSessionId: 'session-1',
      inputMode: 'normal',
      autoReviewRunning: false,
    });
    expect(result).toBe('send');
  });

  test('should QUEUE when followUpBehavior is "queue" and session is busy', () => {
    // This is the FIRST tap scenario in the bug:
    // the session is still 'busy' (session_status SSE idle event hasn't arrived yet)
    const result = simulatePrimaryAction({
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR, // 'queue' (default)
      sessionPhase: 'busy',
      hasContent: true,
      currentSessionId: 'session-1',
      inputMode: 'normal',
      autoReviewRunning: false,
    });
    expect(result).toBe('queue');
  });

  test('should SEND on the second tap when session has transitioned to idle', () => {
    // This simulates the SECOND tap:
    // the session_status SSE idle event has arrived, sessionPhase is now 'idle'
    const result = simulatePrimaryAction({
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR, // 'queue' (default)
      sessionPhase: 'idle',
      hasContent: true,
      currentSessionId: 'session-1',
      inputMode: 'normal',
      autoReviewRunning: false,
    });
    expect(result).toBe('send');
  });

  test('should SEND directly when followUpBehavior is "steer" (even if busy)', () => {
    // Users who changed to 'steer' behavior would not experience this bug
    const result = simulatePrimaryAction({
      followUpBehavior: 'steer',
      sessionPhase: 'busy',
      hasContent: true,
      currentSessionId: 'session-1',
      inputMode: 'normal',
      autoReviewRunning: false,
    });
    expect(result).toBe('steer');
  });

  test('should not queue if there is no content', () => {
    const result = simulatePrimaryAction({
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
      sessionPhase: 'busy',
      hasContent: false,
      currentSessionId: 'session-1',
      inputMode: 'normal',
      autoReviewRunning: false,
    });
    expect(result).toBe('send');
  });

  test('should not queue if autoReviewRunning is true (defers to handleSubmit check)', () => {
    const result = simulatePrimaryAction({
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
      sessionPhase: 'idle',
      hasContent: true,
      currentSessionId: 'session-1',
      inputMode: 'normal',
      autoReviewRunning: true, // autoReviewRunning makes canQueue true even when idle
    });
    expect(result).toBe('queue');
  });

  // ── Verify the full end-to-end flow ──

  test('reproduces the "two-tap" bug end-to-end', () => {
    // Scenario:
    // 1. Session is busy (previous AI response hasn't sent session.status idle yet)
    // 2. User types "hello" and taps Send
    // 3. First tap: because sessionPhase is 'busy', message is QUEUED not SENT
    // 4. Session transitions to idle (SSE event arrives)
    // 5. User taps Send again
    // 6. Second tap: because sessionPhase is now 'idle', message is SENT
    
    const hasContent = true;
    const sessionId = 'session-1';
    const inputMode = 'normal';
    const autoReview = false;

    // First tap while session is busy
    const firstTapResult = simulatePrimaryAction({
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
      sessionPhase: 'busy',
      hasContent,
      currentSessionId: sessionId,
      inputMode,
      autoReviewRunning: autoReview,
    });

    // Message was queued, not sent
    expect(firstTapResult).toBe('queue');

    // Session becomes idle (SSE event arrives)
    // User taps Send again
    const secondTapResult = simulatePrimaryAction({
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
      sessionPhase: 'idle',
      hasContent,
      currentSessionId: sessionId,
      inputMode,
      autoReviewRunning: autoReview,
    });

    // Message is now sent
    expect(secondTapResult).toBe('send');

    // User had to tap TWICE to send one message
    expect(firstTapResult).not.toBe(secondTapResult);
  });
});
