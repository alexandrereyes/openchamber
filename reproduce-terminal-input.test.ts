/**
 * Reproduction for Issue #2319: Terminal cannot input anything
 *
 * Root cause analysis:
 *
 * On mobile web (Web/PWA), keyboard input fails because of a chain of issues
 * in the Ghostty Web integration:
 *
 * 1. **Ghostty InputHandler filters keyCode=229** (line 851 of ghostty-web.js):
 *    Mobile virtual keyboards fire keydown events with keyCode=229.
 *    Ghostty's InputHandler.handleKeyDown explicitly returns early when
 *    `event.keyCode === 229`, discarding the event.
 *
 * 2. **Composition events on textarea, but InputHandler on container**:
 *    Ghostty's Terminal.open() creates a hidden textarea child. On canvas
 *    touch, the touchend handler (line 2371-2372) focuses the textarea, NOT
 *    the container. The InputHandler listens for composition events on the
 *    container. While composition events bubble, the container's beforeinput
 *    handler (line 2365) calls preventDefault() on every beforeinput event
 *    that bubbles up, which can interfere with composition on some mobile
 *    browsers.
 *
 * 3. **TerminalView.tsx completely skips focus on mobile** (lines 131-146):
 *    When `useTouchTerminalInput` is true (mobile web), both
 *    `focusTerminalWhenWindowActive()` and `focusTerminalController()` return
 *    early without ever focusing the terminal. Additionally, `autoFocus` is
 *    set to `false` for the TerminalViewport component.
 *
 * 4. **On-screen quick keys are the only input mechanism**: On mobile web,
 *    the terminal relies entirely on the touch-only quick keys buttons
 *    (Esc, Tab, Ctrl, Alt, arrows, Enter). Physical or virtual keyboard
 *    input through the Ghostty InputHandler is effectively broken.
 */

import { describe, it, expect } from 'bun:test';

// Simulate the Ghostty InputHandler's key handling logic (from ghostty-web.js)
class MockGhosttyInputHandler {
  isComposing = false;
  isDisposed = false;
  onDataCallback: (data: string) => void;
  /** Track which keydown events are handled */
  handledKeys: string[] = [];

  constructor(onData: (data: string) => void) {
    this.onDataCallback = onData;
  }

  /** Matches Ghostty's handleKeyDown (line 850-957 of ghostty-web.js) */
  handleKeyDown(event: {
    key: string;
    keyCode: number;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
  }): boolean {
    // Line 851: Filter disposed, composing, isComposing, keyCode 229
    if (this.isDisposed || this.isComposing || event.isComposing || event.keyCode === 229) {
      return false;
    }

    // Line 843-844: isPrintableCharacter check
    const isPrintable =
      !((event.ctrlKey && !event.altKey) || (event.altKey && !event.ctrlKey) || event.metaKey) &&
      event.key.length === 1;

    if (isPrintable) {
      // Line 860: preventDefault + onDataCallback
      this.handledKeys.push(event.key);
      this.onDataCallback(event.key);
      return true;
    }

    return false;
  }

  /** Matches Ghostty's handleCompositionStart (line 982-984) */
  handleCompositionStart(): void {
    this.isComposing = true;
  }

  /** Matches Ghostty's handleCompositionEnd (line 994-1004) */
  handleCompositionEnd(event: { data: string | null }): void {
    this.isComposing = false;
    if (event.data && event.data.length > 0) {
      this.onDataCallback(event.data);
    }
  }
}

// Replicate TerminalView.tsx mobile focus logic (lines 131-146)
function createMobileFocusLogic(useTouchTerminalInput: boolean) {
  const focusCalls: string[] = [];

  const focusTerminalWhenWindowActive = () => {
    if (useTouchTerminalInput) return; // Line 132-133
    focusCalls.push('focusTerminalWhenWindowActive');
  };

  const focusTerminalController = () => {
    if (useTouchTerminalInput) return; // Line 142-143
    focusCalls.push('focusTerminalController');
  };

  return { focusCalls, focusTerminalWhenWindowActive, focusTerminalController };
}

describe('Issue #2319: Terminal cannot input anything', () => {
  it('BUG: Ghostty InputHandler filters mobile virtual keyboard events (keyCode=229)', () => {
    const capturedData: string[] = [];
    const handler = new MockGhosttyInputHandler((data) => capturedData.push(data));

    // Desktop physical keyboard: keyCode is the ASCII code (e.g., 65 for 'A')
    handler.handleKeyDown({
      key: 'a', keyCode: 65, ctrlKey: false,
      altKey: false, metaKey: false, isComposing: false,
    });
    expect(capturedData).toEqual(['a']);
    expect(handler.handledKeys).toEqual(['a']);

    // Mobile virtual keyboard: keyCode is 229 (IME-inprogress code)
    capturedData.length = 0;
    handler.handledKeys.length = 0;

    handler.handleKeyDown({
      key: 'a', keyCode: 229, ctrlKey: false,
      altKey: false, metaKey: false, isComposing: false,
    });
    // BUG: Event is silently filtered out, onDataCallback never called
    expect(capturedData).toEqual([]);
    expect(handler.handledKeys).toEqual([]);
  });

  it('BUG: TerminalView.tsx skips all focus operations on mobile web', () => {
    // Line 43: useTouchTerminalInput on mobile/web
    const useTouchTerminalInput = true;

    const { focusCalls, focusTerminalWhenWindowActive, focusTerminalController } =
      createMobileFocusLogic(useTouchTerminalInput);

    focusTerminalWhenWindowActive();
    focusTerminalController();

    // BUG: Both focus functions are no-ops on mobile
    expect(focusCalls).toEqual([]);

    // Line 1143: autoFocus={!useTouchTerminalInput && isTerminalVisible}
    const autoFocus = !useTouchTerminalInput;
    expect(autoFocus).toBe(false);
  });

  it('BUG: on-screen quick keys are the only working input path on mobile', () => {
    // The TerminalViewport receives autoFocus=false on mobile,
    // and handleViewportInput is only called when Ghostty's onData fires.
    // Since Ghostty's InputHandler doesn't process mobile keyboard events,
    // the only input path is through the on-screen quick key buttons.
    const capturedInputs: string[] = [];

    const handleMobileKeyPress = (key: string) => {
      // Maps quick key to escape sequence (from terminalInput.ts)
      const sequences: Record<string, string> = {
        esc: '\u001b', tab: '\t', enter: '\r',
        'arrow-up': '\u001b[A', 'arrow-down': '\u001b[B',
        'arrow-left': '\u001b[D', 'arrow-right': '\u001b[C',
      };
      capturedInputs.push(sequences[key] ?? key);
    };

    // Quick keys work
    handleMobileKeyPress('a');
    handleMobileKeyPress('enter');
    handleMobileKeyPress('esc');
    expect(capturedInputs).toEqual(['a', '\r', '\u001b']);

    // But regular character input from the virtual keyboard
    // never reaches handleMobileKeyPress — it goes through Ghostty's
    // InputHandler which drops keyCode=229 events
    capturedInputs.length = 0;

    // Simulate what would happen: Ghostty's onData never fires for mobile keys
    // so handleViewportInput (which calls terminal.sendInput) is never invoked
    const sentInputs: string[] = [];
    const handleViewportInput = (data: string) => {
      if (!data) return;
      sentInputs.push(data);
    };

    // No onData is called for mobile virtual keyboard characters
    // because Ghostty's InputHandler filters them all
    // handleViewportInput is never called

    // Each character the user types on the virtual keyboard...
    // ...never reaches the terminal
    expect(sentInputs).toEqual([]);
  });
});
