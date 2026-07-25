import { afterEach, describe, expect, test } from 'bun:test';

import { QUOTA_PROVIDERS } from '@/lib/quota';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { useQuotaStore } from './useQuotaStore';

const originalFetchProviderQuota = useQuotaStore.getState().fetchProviderQuota;

afterEach(() => {
  useQuotaStore.setState({
    results: [],
    isLoading: false,
    isFetchingProvider: {},
    lastUpdated: null,
    error: null,
    fetchProviderQuota: originalFetchProviderQuota,
  });
});

describe('quota refresh', () => {
  test('preserves results and shares the pending full refresh with duplicate callers', async () => {
    let finishProviderFetch!: () => void;
    const providerFetch = new Promise<void>((resolve) => {
      finishProviderFetch = resolve;
    });
    const fetchedProviderIds: QuotaProviderId[] = [];
    const fetchProviderQuota = async (providerId: QuotaProviderId) => {
      fetchedProviderIds.push(providerId);
      await providerFetch;
    };
    const existingResults: ProviderResult[] = [{
      providerId: 'claude',
      providerName: 'Claude',
      ok: true,
      configured: true,
      usage: null,
      fetchedAt: 1,
    }];
    useQuotaStore.setState({ results: existingResults, fetchProviderQuota });

    const firstRefresh = useQuotaStore.getState().fetchAllQuotas();
    const duplicateRefresh = useQuotaStore.getState().fetchAllQuotas();
    let duplicateSettled = false;
    void duplicateRefresh.then(() => {
      duplicateSettled = true;
    });

    await Promise.resolve();

    expect(duplicateRefresh).toBe(firstRefresh);
    expect(useQuotaStore.getState().results).toBe(existingResults);
    expect(fetchedProviderIds).toEqual(QUOTA_PROVIDERS.map((provider) => provider.id));
    expect(duplicateSettled).toBe(false);

    finishProviderFetch();
    await Promise.all([firstRefresh, duplicateRefresh]);
    expect(duplicateSettled).toBe(true);
    expect(useQuotaStore.getState().isLoading).toBe(false);
  });

  test('clears loading after an unexpected provider rejection', async () => {
    useQuotaStore.setState({
      fetchProviderQuota: async () => {
        throw new Error('unexpected failure');
      },
    });

    await useQuotaStore.getState().fetchAllQuotas();

    expect(useQuotaStore.getState().isLoading).toBe(false);
    expect(useQuotaStore.getState().error).toBe('unexpected failure');
  });
});
