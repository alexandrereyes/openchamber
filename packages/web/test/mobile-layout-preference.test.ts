/**
 * Reproduction test for issue #2131:
 * Android mobile app ignores "Old" mobile layout preference
 *
 * The issue: on Android (installed PWA), selecting "Old" mobile layout
 * (which stores 'default' in localStorage under openchamber-mobile-layout)
 * does not cause the app to switch to the desktop app. The app continues
 * to render the dedicated "New" mobile layout (MobileApp React tree).
 *
 * The surface decision happens in main.tsx detectHostedSurface():
 *   return likelyPhone && getStoredMobileLayoutPreference() === 'new' ? 'mobile' : 'desktop';
 *
 * When "Old" is selected, OpenChamberVisualSettings.tsx calls
 * setStoredMobileLayoutPreference('default') which writes 'default' to
 * localStorage, then calls window.location.reload().
 *
 * On reload, detectHostedSurface() should return 'desktop' because
 * getStoredMobileLayoutPreference() returns 'default', which !== 'new'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MOBILE_LAYOUT_PREFERENCE_KEY = 'openchamber-mobile-layout';

// Mock localStorage
const createMockStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
};

// Replicate the relevant functions from the codebase for testing
type MobileLayoutPreference = 'default' | 'new';

const normalizeMobileLayoutPreference = (value: unknown): MobileLayoutPreference => {
  return value === 'default' ? 'default' : 'new';
};

const getStoredMobileLayoutPreference = (mockStorage: Storage): MobileLayoutPreference => {
  try {
    return normalizeMobileLayoutPreference(
      mockStorage.getItem(MOBILE_LAYOUT_PREFERENCE_KEY)
    );
  } catch {
    return 'new';
  }
};

const setStoredMobileLayoutPreference = (value: MobileLayoutPreference, mockStorage: Storage): boolean => {
  try {
    mockStorage.setItem(MOBILE_LAYOUT_PREFERENCE_KEY, value);
    return true;
  } catch {
    return false;
  }
};

// Simulate the detectHostedSurface logic from main.tsx
const isCoarsePointer = (): boolean => false; // Default to false in test env

const detectHostedSurface = (likelyPhone: boolean, mockStorage: Storage): string => {
  return likelyPhone && getStoredMobileLayoutPreference(mockStorage) === 'new' ? 'mobile' : 'desktop';
};

describe('Mobile Layout Preference — Issue #2131 reproduction', () => {
  let mockStorage: Storage;

  beforeEach(() => {
    mockStorage = createMockStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getStoredMobileLayoutPreference', () => {
    it('returns "new" when nothing is stored (default behavior)', () => {
      expect(getStoredMobileLayoutPreference(mockStorage)).toBe('new');
    });

    it('returns "new" when "new" is stored', () => {
      mockStorage.setItem(MOBILE_LAYOUT_PREFERENCE_KEY, 'new');
      expect(getStoredMobileLayoutPreference(mockStorage)).toBe('new');
    });

    it('returns "default" when "default" is stored (Old layout selected)', () => {
      mockStorage.setItem(MOBILE_LAYOUT_PREFERENCE_KEY, 'default');
      expect(getStoredMobileLayoutPreference(mockStorage)).toBe('default');
    });

    it('returns "new" for any unknown/unexpected value', () => {
      mockStorage.setItem(MOBILE_LAYOUT_PREFERENCE_KEY, 'old');
      expect(getStoredMobileLayoutPreference(mockStorage)).toBe('new');
      mockStorage.setItem(MOBILE_LAYOUT_PREFERENCE_KEY, '');
      expect(getStoredMobileLayoutPreference(mockStorage)).toBe('new');
      mockStorage.setItem(MOBILE_LAYOUT_PREFERENCE_KEY, 'desktop');
      expect(getStoredMobileLayoutPreference(mockStorage)).toBe('new');
    });
  });

  describe('setStoredMobileLayoutPreference + get round-trip', () => {
    it('correctly round-trips "default" (Old layout)', () => {
      setStoredMobileLayoutPreference('default', mockStorage);
      expect(getStoredMobileLayoutPreference(mockStorage)).toBe('default');
    });

    it('correctly round-trips "new" (New layout)', () => {
      setStoredMobileLayoutPreference('new', mockStorage);
      expect(getStoredMobileLayoutPreference(mockStorage)).toBe('new');
    });
  });

  describe('detectHostedSurface (surface decision from main.tsx)', () => {
    it('returns "mobile" when likelyPhone=true and preference is "new"', () => {
      setStoredMobileLayoutPreference('new', mockStorage);
      expect(detectHostedSurface(true, mockStorage)).toBe('mobile');
    });

    it('returns "desktop" when likelyPhone=true and preference is "default" (Old layout selected)', () => {
      // This is the scenario when the user selects "Old" layout and reloads
      setStoredMobileLayoutPreference('default', mockStorage);
      expect(detectHostedSurface(true, mockStorage)).toBe('desktop');
    });

    it('returns "desktop" when likelyPhone=false regardless of preference', () => {
      setStoredMobileLayoutPreference('new', mockStorage);
      expect(detectHostedSurface(false, mockStorage)).toBe('desktop');
      setStoredMobileLayoutPreference('default', mockStorage);
      expect(detectHostedSurface(false, mockStorage)).toBe('desktop');
    });

    it('returns "desktop" when preference is "default" even on a phone-like device', () => {
      // This simulates the exact bug scenario:
      // - User on a phone (likelyPhone=true)
      // - Sets preference to "Old" (stores 'default')
      // - After reload, the correct behavior is to return 'desktop'
      setStoredMobileLayoutPreference('default', mockStorage);
      const surface = detectHostedSurface(true, mockStorage);
      expect(surface).toBe('desktop');
      // If this assertion fails, the surface detection would still
      // load the MobileApp, which is exactly the bug described in #2131
    });
  });

  describe('Simulated end-to-end flow (issue #2131 scenario)', () => {
    it('simulates the full flow: select "Old" → reload → surface=desktop', () => {
      // Step 1: Start with default "New" preference
      expect(getStoredMobileLayoutPreference(mockStorage)).toBe('new');

      // Step 2: User is on a phone (New mobile app loaded)
      expect(detectHostedSurface(true, mockStorage)).toBe('mobile');

      // Step 3: User selects "Old" layout in settings
      // (simulates handleMobileLayoutPreferenceChange('default'))
      const stored = setStoredMobileLayoutPreference('default', mockStorage);
      expect(stored).toBe(true);

      // Step 4: Verify the value was persisted to localStorage
      expect(mockStorage.getItem(MOBILE_LAYOUT_PREFERENCE_KEY)).toBe('default');
      expect(getStoredMobileLayoutPreference(mockStorage)).toBe('default');

      // Step 5: Simulate page reload (re-run detectHostedSurface)
      // After reload, the surface should be 'desktop'
      const surfaceAfterReload = detectHostedSurface(true, mockStorage);
      expect(surfaceAfterReload).toBe('desktop');
      // If this test passes, the code logic is correct but the issue
      // must be caused by an environment-specific factor on Android PWA
      // (e.g., localStorage persistence, service worker caching, etc.)
    });
  });
});
