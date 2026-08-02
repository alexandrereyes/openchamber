import { afterEach, describe, expect, test } from 'bun:test';

import { QUOTA_PROVIDERS } from '@/lib/quota';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
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

  test('deduplicates per runtime without joining another runtime request', async () => {
    const originalApiBaseUrl = getRuntimeApiBaseUrl();
    const originalRuntimeKey = getRuntimeKey();
    let finishRuntimeA!: () => void;
    let finishRuntimeB!: () => void;
    const runtimeAProviderFetch = new Promise<void>((resolve) => {
      finishRuntimeA = resolve;
    });
    const runtimeBProviderFetch = new Promise<void>((resolve) => {
      finishRuntimeB = resolve;
    });
    const callsByRuntime = new Map<string, number>();
    useQuotaStore.setState({
      fetchProviderQuota: async () => {
        const runtimeKey = getRuntimeKey();
        callsByRuntime.set(runtimeKey, (callsByRuntime.get(runtimeKey) ?? 0) + 1);
        await (runtimeKey === 'runtime-a' ? runtimeAProviderFetch : runtimeBProviderFetch);
      },
    });

    let runtimeARequest: Promise<void> | null = null;
    let runtimeBRequest: Promise<void> | null = null;
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.test', runtimeKey: 'runtime-a' });
      runtimeARequest = useQuotaStore.getState().fetchAllQuotas();
      expect(useQuotaStore.getState().fetchAllQuotas()).toBe(runtimeARequest);

      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.test', runtimeKey: 'runtime-b' });
      runtimeBRequest = useQuotaStore.getState().fetchAllQuotas();
      expect(runtimeBRequest).not.toBe(runtimeARequest);
      expect(useQuotaStore.getState().fetchAllQuotas()).toBe(runtimeBRequest);
      expect(callsByRuntime.get('runtime-a')).toBe(QUOTA_PROVIDERS.length);
      expect(callsByRuntime.get('runtime-b')).toBe(QUOTA_PROVIDERS.length);

      finishRuntimeA();
      await runtimeARequest;
      expect(useQuotaStore.getState().fetchAllQuotas()).toBe(runtimeBRequest);
      expect(useQuotaStore.getState().isLoading).toBe(true);

      finishRuntimeB();
      await runtimeBRequest;
    } finally {
      finishRuntimeA();
      finishRuntimeB();
      await Promise.allSettled([runtimeARequest, runtimeBRequest].filter((request): request is Promise<void> => request !== null));
      switchRuntimeEndpoint({ apiBaseUrl: originalApiBaseUrl, runtimeKey: originalRuntimeKey });
    }
  });

  test('clears loading when an old runtime finishes and the current runtime is idle', async () => {
    const originalApiBaseUrl = getRuntimeApiBaseUrl();
    const originalRuntimeKey = getRuntimeKey();
    let finishRuntimeA!: () => void;
    const runtimeAProviderFetch = new Promise<void>((resolve) => {
      finishRuntimeA = resolve;
    });
    useQuotaStore.setState({
      fetchProviderQuota: async () => {
        await runtimeAProviderFetch;
      },
    });

    let runtimeARequest: Promise<void> | null = null;
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.test', runtimeKey: 'runtime-a' });
      runtimeARequest = useQuotaStore.getState().fetchAllQuotas();
      expect(useQuotaStore.getState().isLoading).toBe(true);

      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.test', runtimeKey: 'runtime-b' });
      finishRuntimeA();
      await runtimeARequest;

      expect(useQuotaStore.getState().isLoading).toBe(false);
    } finally {
      finishRuntimeA();
      if (runtimeARequest) await runtimeARequest;
      switchRuntimeEndpoint({ apiBaseUrl: originalApiBaseUrl, runtimeKey: originalRuntimeKey });
    }
  });
});
