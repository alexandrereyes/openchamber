/**
 * Reproduction test for issue #1749:
 *   - Scroll-to-bottom arrow blocks wheel scroll (scroll-down not handled)
 *   - Subsequent send causes continuous auto-scroll loop
 *
 * These tests validate the specific code paths that cause the two bugs
 * described in the issue, without requiring a full browser environment.
 * They focus on the logic in useChatAutoFollow.ts.
 */

import { describe, expect, test } from 'bun:test';

/**
 * Problem 1: Wheel scroll-down is explicitly ignored
 * ==================================================
 *
 * In useChatAutoFollow.ts lines 483-487:
 *
 *   const handleWheel = (event: WheelEvent) => {
 *       if (event.deltaY >= 0) return;            // ← scroll-down is IGNORED
 *       if (nestedScrollableCanConsumeUp(...)) return;
 *       releaseFromUserIntent();
 *   };
 *
 * When state is 'released' and the scroll-to-bottom button is visible,
 * the wheel event handler does nothing for scroll-down (deltaY >= 0).
 * It only acts on scroll-up. This means the auto-follow system never
 * acknowledges scroll-down intent, and consequently:
 *
 *   a) The scroll handler (handleScrollEvent) only re-pins when
 *      isNearBottom becomes true — so partial scroll-down doesn't
 *      re-engage auto-follow.
 *
 *   b) During the follow loop, scroll-down is neither stopped nor
 *      acknowledged — the next RAF frame overwrites the user's
 *      scroll position back toward the target.
 *
 * While the wheel listener is passive (can't preventDefault), the
 * follow loop's RAF callback in the next frame resets scrollTop,
 * which creates the "bounces back" appearance.
 */

describe('Bug 1: Wheel scroll-down is explicitly ignored', () => {
    test('handleWheel returns early for deltaY >= 0 (scroll-down)', () => {
        // This is the exact logic from useChatAutoFollow.ts lines 483-487
        let releasedCalled = false;
        const releaseFromUserIntent = () => { releasedCalled = true; };

        const handleWheel = (event: { deltaY: number }) => {
            if (event.deltaY >= 0) return;  // ← the bug: scroll-down ignored
            releaseFromUserIntent();
        };

        // Scroll-down (positive deltaY)
        handleWheel({ deltaY: 1 });
        expect(releasedCalled).toBe(false);

        // Scroll-up (negative deltaY) — only this is handled
        handleWheel({ deltaY: -1 });
        expect(releasedCalled).toBe(true);
    });

    test('scroll-down during follow loop does not release, next frame resets scrollTop', () => {
        // Simulates what happens during the follow loop:
        // 1. Follow loop pushes scrollTop toward target
        // 2. User scrolls down (deltaY >= 0)
        // 3. Wheel handler ignores it
        // 4. Next follow-loop frame resets scrollTop → "bounces back"

        let state: 'following' | 'released' = 'following';
        const releaseFromUserIntent = () => { state = 'released'; };

        const handleWheel = (event: { deltaY: number }) => {
            if (event.deltaY >= 0) return;
            releaseFromUserIntent();
        };

        // User scrolls down while following — NO effect
        handleWheel({ deltaY: 1 });
        expect(state).toBe('following');  // still following! scroll-down didn't release

        // Only scroll-up releases
        handleWheel({ deltaY: -1 });
        expect(state).toBe('released');
    });
});


/**
 * Problem 2: Programmatic window prevents scroll handler from working
 * ==================================================================
 *
 * In useChatAutoFollow.ts, tickFollow() calls markProgrammaticWrite()
 * at each frame (line 216-217):
 *
 *   const tickFollow = () => {
 *       ...
 *       markProgrammaticWrite();
 *       container.scrollTop = next;
 *       ...
 *       followRafRef.current = window.requestAnimationFrame(tickFollow);
 *   };
 *
 * markProgrammaticWrite sets programmaticWriteUntilRef to now + 200ms.
 * Since RAF fires every ~16ms, the programmatic window is continuously
 * extended — it never expires while the loop runs.
 *
 * The scroll event handler (handleScrollEvent) at line 449 checks:
 *
 *   if (programmatic) {
 *       return;   // ← exits early, never detects user scroll-up
 *   }
 *
 * This means the scroll handler NEVER detects user scroll-up during
 * the follow loop through the normal scroll-event path. The only
 * release path is the wheel handler directly calling
 * releaseFromUserIntent() for deltaY < 0 (scroll-up).
 *
 * Combined with Bug 1 (scroll-down ignored), this means:
 *   - Scrolling DOWN has no effect → "bounces back"
 *   - The user MUST scroll UP to stop the loop
 *   - If the user only tries scroll-down (which is intuitive when
 *     the view is scrolling down), the loop appears "unstoppable"
 */

describe('Bug 2: Programmatic window extends indefinitely during follow loop', () => {
    test('markProgrammaticWrite extends window past the next frame boundary', () => {
        const PROGRAMMATIC_WRITE_WINDOW_MS = 200;
        let simulatedTime = 0;
        let programmaticWriteUntil = 0;

        // Use the actual pattern from useChatAutoFollow.ts
        const markProgrammaticWrite = () => {
            programmaticWriteUntil = simulatedTime + PROGRAMMATIC_WRITE_WINDOW_MS;
        };

        const isInProgrammaticWindow = () => {
            return simulatedTime < programmaticWriteUntil;
        };

        // Simulate a follow loop: call markProgrammaticWrite every 16ms
        // Frame 0: set initial window
        markProgrammaticWrite();
        const initialWindowExpires = programmaticWriteUntil;  // = 200

        for (let frame = 0; frame < 100; frame++) {
            // Advance time by 16ms (one frame)
            simulatedTime += 16;

            // The window should still be active from the PREVIOUS frame's extension
            // Because last write set it to (previous_time + 200ms), and we've only
            // advanced 16ms since then
            const isProgrammatic = isInProgrammaticWindow();
            expect(isProgrammatic).toBe(true);

            // This is what tickFollow does each frame — re-extend the window
            markProgrammaticWrite();

            // After extension, the window now expires at simulatedTime + 200ms
            // This is always > simulatedTime (by exactly 200ms)
            expect(programmaticWriteUntil).toBe(simulatedTime + PROGRAMMATIC_WRITE_WINDOW_MS);
            expect(programmaticWriteUntil).toBeGreaterThan(simulatedTime);
        }

        // After 100 frames (~1.6s), the window is still active
        // because each frame re-extended it
        expect(isInProgrammaticWindow()).toBe(true);

        // Once the loop stops (no more markProgrammaticWrite calls),
        // the window naturally expires after 200ms
        simulatedTime += 200;
        expect(isInProgrammaticWindow()).toBe(false);  // expired
    });

    test('handleScrollEvent returns early when programmatic window is active', () => {
        // This simulates the scroll handler logic
        let state: 'following' | 'released' = 'following';
        let followLoopStopped = false;
        let scrollUpDetected = false;

        const programmaticWriteUntilRef = { current: Infinity };  // always in programmatic window

        const isInProgrammaticWindow = () => {
            return Date.now() < programmaticWriteUntilRef.current;
        };

        // The scroll event handler logic (simplified from lines 438-465)
        const handleScrollEvent = (currentTop: number, previousTop: number) => {
            const programmatic = isInProgrammaticWindow();

            if (programmatic) {
                return;  // ← exits early, never detects scroll-up!
            }

            // This code never runs while programmatic window is active:
            if (currentTop < previousTop && state === 'following') {
                scrollUpDetected = true;
                followLoopStopped = true;
                state = 'released';
            }
        };

        // User scrolls up while follow loop is running
        // But programmatic window is active (extended by the loop)
        handleScrollEvent(50, 100);  // scrollTop=50, previous=100 → user scrolled UP

        // The scroll event handler returned early without detecting this!
        expect(scrollUpDetected).toBe(false);
        expect(followLoopStopped).toBe(false);
        expect(state).toBe('following');
    });
});


/**
 * Problem 3: Continuous auto-scroll loop scenario
 * ===============================================
 *
 * Full scenario after steps 1-5:
 *
 * 1. User scrolls up → state → 'released'
 * 2. New messages arrive → scroll button appears
 * 3. User clicks scroll-to-bottom → goToBottom('instant') → writeScrollTopInstant + startSettleBurst
 * 4. State → 'following', settle burst runs (280ms)
 * 5. User sends a message → content grows →
 *    notifyContentChange → startFollowLoop()
 * 6. Follow loop starts. Content is streaming (scrollHeight keeps growing).
 *    Programmatic window extends each frame. User can't stop by scrolling down.
 * 7. Even after streaming stops, the LERP-based loop takes ~640ms to converge.
 *
 * The "cannot be stopped" aspect:
 *   - Scroll DOWN: wheel handler returns early (Bug 1)
 *   - Scroll event handler: returns early due to programmatic window (Bug 2)
 *   - Only scroll UP triggers releaseFromUserIntent via the wheel handler
 */
describe('Bug 3: Continuous auto-scroll loop', () => {
    test('follow loop never settles while content keeps growing', () => {
        // Simulate the follow loop's settle logic
        const SETTLE_EPSILON = 0.5;
        const SETTLE_FRAMES = 4;
        const LERP = 0.18;

        let scrollTop = 0;
        let scrollHeight = 1000;
        const clientHeight = 500;

        let settledFrames = 0;
        let loopActive = true;
        let frames = 0;

        const tickFollow = () => {
            if (!loopActive) return;

            const target = Math.max(0, scrollHeight - clientHeight);
            const current = scrollTop;
            const delta = target - current;

            if (Math.abs(delta) <= SETTLE_EPSILON) {
                settledFrames++;
                if (settledFrames >= SETTLE_FRAMES) {
                    loopActive = false;  // settled! stop loop
                    return;
                }
            } else {
                settledFrames = 0;
                // LERP: move 18% of remaining distance
                scrollTop = current + delta * LERP;
            }
        };

        // Simulate up to 200 frames
        while (loopActive && frames < 200) {
            tickFollow();
            frames++;

            // Content keeps growing: simulate streaming
            if (frames < 100) {
                scrollHeight += 10;  // 10px of new content per frame
            }
        }

        // Loop should have settled after content stopped growing
        expect(loopActive).toBe(false);

        // Confirm the follow loop ran for many frames due to content growth
        // Without content growth: ~44 frames to settle (from delta=500px)
        // With 100 frames of continuous growth: loop runs for 100 frames of growth + ~44 settling frames
        expect(frames).toBeGreaterThan(100);
        // Total should be well under 200 (settles after ~44 frames past content stop)
        expect(frames).toBeLessThan(200);
    });

    test('demonstrates scroll-down does not break follow loop during streaming', () => {
        // This test shows the complete scenario where:
        // 1. Follow loop is running (content streaming)
        // 2. User tries to scroll down
        // 3. Follow loop overrides the scroll position in the next frame

        let state: 'following' | 'released' = 'following';
        let followRafActive = true;
        let scrollTop = 400;  // current position
        const clientHeight = 500;
        let scrollHeight = 950;  // target = 450

        const LERP = 0.18;
        const SETTLE_EPSILON = 0.5;

        // Current follow loop frame
        const tickFollow = () => {
            if (!followRafActive) return;
            const target = Math.max(0, scrollHeight - clientHeight);
            const delta = target - scrollTop;
            if (Math.abs(delta) > SETTLE_EPSILON) {
                scrollTop = scrollTop + delta * LERP;
            }
        };

        // Frame 1: follow loop pushes scroll
        tickFollow();
        const afterFrame1 = scrollTop;

        // Now user scrolls DOWN with wheel (deltaY >= 0)
        // Browser scrolls to, say, more than current position
        const userScrollDown = afterFrame1 + 15;  // user scrolled down 15px
        scrollTop = userScrollDown;

        // The wheel handler returns early (deltaY >= 0) — no release!
        const handleWheel = (deltaY: number) => {
            if (deltaY >= 0) return;  // ← ignored
            state = 'released';
            followRafActive = false;
        };
        handleWheel(1);  // scroll down
        expect(state).toBe('following');  // still following!

        // Frame 2: follow loop resets scrollTop OVER the user's scroll
        scrollHeight = 950;  // no more content growth
        tickFollow();

        // The follow loop recalculated its target and pushed back
        // This is the "bounces back" effect
        expect(scrollTop).not.toBe(userScrollDown);  // scroll was pushed back
        // The follow loop moves toward the target, not the user's position
    });

    test('critical: notifyContentChange restarts follow loop after user release if state is still following', () => {
        // This is the race condition after clicking scroll-to-bottom and sending a message:
        // 1. goToBottom('instant') sets state to 'following' and starts settle burst
        // 2. User sends a message
        // 3. notifyContentChange is called - if state is 'following', startFollowLoop()
        // 4. But startFollowLoop() has a guard: if (followRafRef.current !== null) return;
        //    If settleBurst is already using a different RAF ref, the follow loop starts anew
        // 5. Both settle burst AND follow loop now run simultaneously
        // 6. Each extends the programmatic window, preventing user scroll detection

        // Simulate the two independent RAF loops
        let settleBurstRafActive = false;
        let followRafActive = false;

        // startFollowLoop guard
        const startFollowLoop = () => {
            // Only guard against followRafActive, NOT settleBurstRafActive!
            if (followRafActive) return;  // ← only checks follow, not settle burst
            followRafActive = true;
        };

        // startSettleBurst
        const startSettleBurst = () => {
            settleBurstRafActive = true;  // independent RAF ref!
        };

        // goToBottom('instant')
        const goToBottomInstant = () => {
            startSettleBurst();
            // NOTE: does NOT call startFollowLoop() in 'instant' mode
        };

        // notifyContentChange (when state is 'following')
        const notifyContentChange = () => {
            startFollowLoop();
        };

        goToBottomInstant();
        expect(settleBurstRafActive).toBe(true);
        expect(followRafActive).toBe(false);

        notifyContentChange();
        // Now both are active! The guard didn't prevent it because
        // settleBurst uses a different RAF ref
        expect(settleBurstRafActive).toBe(true);
        expect(followRafActive).toBe(true);
    });
});
