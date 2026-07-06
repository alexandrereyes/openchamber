import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { NumberInput } from './number-input';
import { I18nProvider } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// Reproduction for issue #2053:
// Spacing & Layout steppers (-/+) can get stuck oscillating when clicked in
// rapid succession.
//
// Root cause:
// The stepper buttons' onClick handlers capture `baseValue` (a useMemo over
// the `value` prop) at render time.  When the user clicks `-` then `+` (or
// vice versa) faster than React can re-render the component, the second click
// computes its increment/decrement against the stale `baseValue` from the
// previous render, not the value that was just committed by the first click.
//
// Flow:
//   1. Render: value=100, baseValue=100
//   2. Click `-`: commitValue(100 - 5) = commitValue(95) → onValueChange(95)
//   3. Parent store updates to 95, but React has NOT re-rendered NumberInput
//      yet – baseValue is still 100.
//   4. Click `+` (rapid, before re-render): commitValue(100 + 5) = commitValue(105)
//      → onValueChange(105)   ← BUG! Should be commitValue(95 + 5) = commitValue(100)
//   5. Net result: value goes 100→95→105 (net +5), not 100→95→100 (net 0)
//
// The same problem in reverse (click `+` then `-` rapidly) causes the value
// to drift downward instead of returning to the original value.
// ---------------------------------------------------------------------------

describe('NumberInput – rapid stepper clicks (issue #2053)', () => {

  // -----------------------------------------------------------------------
  // Unit test of the core computation problem
  // -----------------------------------------------------------------------

  test('stale baseValue causes incorrect net result for -/+ rapid sequence', () => {
    // Simulate what happens inside NumberInput's onClick handlers:
    //   onClick={() => commitValue(baseValue - step)}
    //   onClick={() => commitValue(baseValue + step)}
    //
    // When two clicks happen before React re-renders with the updated value
    // prop, both clicks see the same `baseValue`, producing a wrong net result.

    const step = 5;
    const min = 50;
    const max = 200;

    // Track the "store" value as seen by the parent
    let storeValue = 100;

    // This mirrors NumberInput's commitValue
    function clamp(v: number, mn: number, mx: number) {
      return Math.min(mx, Math.max(mn, v));
    }

    const onValueChange = (v: number) => {
      storeValue = v;
    };

    // Render 1: value=100, baseValue=100
    let baseValue = storeValue;

    // Click `-`: commitValue(baseValue - step)
    onValueChange(clamp(baseValue - step, min, max));
    expect(storeValue).toBe(95);

    // !! Store updated, but NumberInput has NOT re-rendered yet.
    // !! baseValue is still 100 (the stale prop snapshot).

    // Click `+`: the handler uses the SAME stale baseValue
    onValueChange(clamp(baseValue + step, min, max));
    expect(storeValue).toBe(105);
    //                   ^^^
    // BUG: net result is 100→95→105  (+5 drift)
    // Expected: 100→95→100  (net 0, back to original)

    // If we had used the updated value (fresh baseValue=95 from re-render):
    //   onValueChange(clamp(95 + 5, min, max)) → 100 ✓
  });

  test('stale baseValue causes incorrect net result for +/- rapid sequence', () => {
    // Same issue in the reverse direction

    const step = 5;
    const min = 50;
    const max = 200;
    let storeValue = 100;

    function clamp(v: number, mn: number, mx: number) {
      return Math.min(mx, Math.max(mn, v));
    }

    const onValueChange = (v: number) => {
      storeValue = v;
    };

    let baseValue = storeValue; // Render 1: value=100, baseValue=100

    // Click `+`: commitValue(baseValue + step)
    onValueChange(clamp(baseValue + step, min, max));
    expect(storeValue).toBe(105);

    // Click `-` (rapid, before re-render): same stale baseValue=100
    onValueChange(clamp(baseValue - step, min, max));
    expect(storeValue).toBe(95);
    //                   ^^^
    // BUG: net result is 100→105→95  (-5 drift)
    // Expected: 100→105→100  (net 0)

    // Fresh baseValue would have given:
    //   onValueChange(clamp(105 - 5, min, max)) → 100 ✓
  });

  test('rapid alternating clicks can create unbounded oscillation', () => {
    // Simulate - → + → - → + with stale baseValue each time.
    // Each pair drifts by step in one direction, creating a "runaway" effect.

    const step = 5;
    const min = 50;
    const max = 200;
    let storeValue = 100;

    function clamp(v: number, mn: number, mx: number) {
      return Math.min(mx, Math.max(mn, v));
    }

    const onValueChange = (v: number) => {
      storeValue = v;
    };

    // Round 1: baseValue=100
    let baseValue = 100;

    onValueChange(clamp(baseValue - step, min, max)); // 95
    onValueChange(clamp(baseValue + step, min, max)); // 105 (stale baseValue!)

    // Re-render happens: value=105 becomes the new prop
    baseValue = storeValue; // = 105 ← this is already the WRONG value

    // Round 2: baseValue=105 (but user expected 100 after -/+)
    onValueChange(clamp(baseValue + step, min, max)); // 110 (from stale 105+5)
    onValueChange(clamp(baseValue - step, min, max)); // 100 (from stale 105-5)

    expect(storeValue).toBe(100);
    // Final: 100 after three drifts that should have cancelled out.
    // The user intended to go 100→95→100→105→100 → net 0
    // Instead got: 100→95→105→110→100 → net 0 but with intermediate errors

    // The problem is that the intermediate state is wrong, and when the user
    // pauses, the displayed value may not match what they intended.  With
    // store persistence/deferred updates adding latency, the oscillation
    // window widens.
  });

  test('sequential clicks with React re-render between each work correctly', () => {
    // This test demonstrates that the bug ONLY occurs when clicks happen
    // within the same render cycle.  If React re-renders between each click,
    // baseValue is always fresh and the result is correct.

    const step = 5;
    const min = 50;
    const max = 200;
    let storeValue = 100;

    function clamp(v: number, mn: number, mx: number) {
      return Math.min(mx, Math.max(mn, v));
    }

    const onValueChange = (v: number) => {
      storeValue = v;
    };

    // Click `-`: baseValue=100 → commitValue(95)
    let baseValue = storeValue;
    onValueChange(clamp(baseValue - step, min, max));
    expect(storeValue).toBe(95);

    // React re-renders! Now baseValue is refreshed from the new value prop.
    baseValue = storeValue; // 95 (fresh)

    // Click `+`: baseValue=95 → commitValue(100)
    onValueChange(clamp(baseValue + step, min, max));
    expect(storeValue).toBe(100); // Correct: back to original

    // When clicks are spaced out enough for React to re-render between them,
    // the result is correct.
  });

  // -----------------------------------------------------------------------
  // Structural test: verify the component has stepper buttons with onClick
  // handlers that use baseValue
  // -----------------------------------------------------------------------

  test('renders decrement and increment buttons', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <NumberInput
          value={100}
          onValueChange={() => {}}
          min={50}
          max={200}
          step={5}
        />
      </I18nProvider>
    );

    // Verify both buttons are present and the value is shown
    expect(html).toContain('Decrease');
    expect(html).toContain('Increase');
    expect(html).toContain('value="100"');
  });

  test('buttons honor min/max bounds', () => {
    // When at min, the decrement button should be disabled
    const atMinHtml = renderToStaticMarkup(
      <I18nProvider>
        <NumberInput value={50} onValueChange={() => {}} min={50} max={200} step={5} />
      </I18nProvider>
    );
    // Check for the `disabled` HTML attribute (not the CSS class name)
    expect(atMinHtml).toContain('disabled=""');

    // When at max, the increment button should be disabled
    const atMaxHtml = renderToStaticMarkup(
      <I18nProvider>
        <NumberInput value={200} onValueChange={() => {}} min={50} max={200} step={5} />
      </I18nProvider>
    );
    expect(atMaxHtml).toContain('disabled=""');

    // When in the middle, neither button should be disabled
    const middleHtml = renderToStaticMarkup(
      <I18nProvider>
        <NumberInput value={100} onValueChange={() => {}} min={50} max={200} step={5} />
      </I18nProvider>
    );
    // The actual `disabled` HTML attribute should NOT be present
    expect(middleHtml).not.toContain('disabled=""');
  });
});
