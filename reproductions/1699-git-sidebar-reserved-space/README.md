# Reproduction: Git panel leaves empty space after closing (#1699)

## Root Cause

The `RightSidebar.tsx` component's resize handler (`applyLiveWidth`) sets `minWidth` and `maxWidth` via **direct DOM manipulation** (`sidebar.style.minWidth = ...`), but these properties are **never included in the React `style` prop** and **never cleaned up** after the resize ends.

When the sidebar is later closed, React sets `width: 0px` via the style prop, but the leftover inline `minWidth` (e.g., `360px` from the last resize) persists on the DOM element. Since CSS `min-width` overrides `width`, the sidebar's effective width stays at `360px` even though the content is visually hidden (opacity-0, pointer-events-none). This leaves an empty gap and compresses the chat area.

### The left sidebar does this correctly

The left `Sidebar.tsx` properly includes `minWidth` and `maxWidth` in its React `style` prop and transitions them:
```tsx
style={{
    width: `${currentWidth}px`,
    minWidth: `${currentWidth}px`,       // ← present
    maxWidth: `${currentWidth}px`,       // ← present
    transitionProperty: 'width, min-width, max-width',  // ← includes both
}}
```

### RightSidebar.tsx is missing these

RightSidebar only sets `width` in the style prop and only transitions `width`:
```tsx
style={{
    width: `${currentWidth}px`,          // ← the only dimension property
    transitionProperty: 'width',         // ← only width
    // minWidth and maxWidth are MISSING from style prop
}}
```

But its resize handler (`applyLiveWidth`) writes `minWidth`/`maxWidth` directly to the DOM:
```tsx
sidebar.style.minWidth = `${nextWidth}px`;   // ← direct DOM, never cleaned up
sidebar.style.maxWidth = `${nextWidth}px`;   // ← direct DOM, never cleaned up
```

## Steps to Reproduce

1. Open the OpenChamber interface
2. Open the right sidebar (click Git management button)
3. Drag the resize handle on the left edge of the sidebar to resize it (even slightly)
4. Close the sidebar (click the Git button again)
5. **Observed**: The sidebar area remains as an empty gap, compressing the chat area
6. **Expected**: The sidebar collapses to 0 width and the chat area expands back

> Note: The reporter may not have mentioned step 3 because once you've resized the panel once in a session, the space remains reserved on all subsequent close/open cycles. The issue persists even when closing via auto-close on window resize.

## Verification

Run the reproduction HTML by opening `reproduction.html` in a browser.
