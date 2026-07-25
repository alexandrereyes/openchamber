import { describe, expect, test } from 'bun:test';

import { shouldRefreshQuotaOnMetadataOpen } from './mobileSessionMetadata';

const NOW = 100_000;
const REFRESH_INTERVAL_MS = 60_000;
const baseInput = {
  open: true,
  wasOpen: false,
  isLoading: false,
  dropdownProviderIds: ['claude'],
  results: [{ providerId: 'claude' }],
  lastUpdated: NOW,
  refreshIntervalMs: REFRESH_INTERVAL_MS,
  now: NOW,
};

describe('mobile session metadata quota refresh', () => {
  test('refreshes on first load without a timestamp', () => {
    expect(shouldRefreshQuotaOnMetadataOpen({ ...baseInput, lastUpdated: null })).toBe(true);
  });

  test('refreshes data at the configured stale boundary', () => {
    expect(shouldRefreshQuotaOnMetadataOpen({
      ...baseInput,
      lastUpdated: NOW - REFRESH_INTERVAL_MS,
    })).toBe(true);
  });

  test('does not refresh data that is still fresh', () => {
    expect(shouldRefreshQuotaOnMetadataOpen({
      ...baseInput,
      lastUpdated: NOW - REFRESH_INTERVAL_MS + 1,
    })).toBe(false);
  });

  test('refreshes a missing enabled provider even when existing data is fresh', () => {
    expect(shouldRefreshQuotaOnMetadataOpen({
      ...baseInput,
      dropdownProviderIds: ['claude', 'codex'],
    })).toBe(true);
  });

  test('does not duplicate a refresh already active when the panel opens', () => {
    expect(shouldRefreshQuotaOnMetadataOpen({
      ...baseInput,
      isLoading: true,
      lastUpdated: null,
    })).toBe(false);
  });

  test('refreshes at most once while open and checks again after closing', () => {
    let wasOpen = false;
    let refreshes = 0;
    const render = (open: boolean) => {
      if (shouldRefreshQuotaOnMetadataOpen({
        ...baseInput,
        open,
        wasOpen,
        lastUpdated: null,
      })) refreshes += 1;
      wasOpen = open;
    };

    render(false);
    render(true);
    render(true);
    render(true);
    expect(refreshes).toBe(1);

    render(false);
    render(true);
    expect(refreshes).toBe(2);
  });
});
