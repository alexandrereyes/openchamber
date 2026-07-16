/**
 * Reproduction test for the race condition in issue #2281.
 *
 * The race:
 * 1. A status request starts before a mutation and is in-flight.
 * 2. The mutation succeeds and the HTTP adapter invalidates its cache/in-flight map.
 * 3. The UI immediately calls fetchStatus().
 * 4. useGitStore still sees its own pre-mutation promise in `inFlightStatusFetches`
 *    and returns it unconditionally (no per-directory generation check).
 * 5. The stale (pre-mutation) result is applied as the post-mutation refresh.
 *
 * These tests demonstrate:
 *   - inFlightStatusFetches dedup prevents a fresh fetch after mutation
 *   - Stale pre-mutation status can overwrite the store after a mutation
 *   - fetchAll({ force: true }) does not force status refresh
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitStatus } from '@/lib/api/types';
import { useGitStore } from './useGitStore';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[1];

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeStatus = (current: string, extra?: Partial<GitStatus>): GitStatus => ({
  current,
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  ...extra,
});

const createGitApi = (getGitStatusImpl: GitAPI['getGitStatus']): GitAPI => ({
  checkIsGitRepository: async () => true,
  getGitStatus: getGitStatusImpl,
  getGitBranches: async () => ({ all: [], current: 'main', branches: {} }),
  getGitLog: async () => ({ all: [], latest: null, total: 0 }),
  getCurrentGitIdentity: async () => null,
  getGitFileDiff: async (_directory, options) => ({ original: '', modified: '', path: options.path }),
});

describe('Issue #2281 – useGitStore fetchStatus race condition', () => {
  beforeEach(() => {
    useGitStore.setState({
      directories: new Map(),
      activeDirectory: null,
    });
  });

  test('inFlightStatusFetches dedup prevents a fresh fetch after simulated mutation', async () => {
    // Track how many times git.getGitStatus is actually called
    let gitStatusCalls = 0;
    const pending = createDeferred<GitStatus>();
    const git = createGitApi(async () => {
      gitStatusCalls++;
      return pending.promise;
    });

    // Step 1: Start fetchStatus (before mutation)
    const firstPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });

    // Step 2: Let the microtask queue flush so the first call's IIFE has
    // been created and stored in inFlightStatusFetches.
    await Promise.resolve();
    await Promise.resolve();

    // Step 3: Simulate a mutation that would invalidate HTTP cache.
    // Call fetchStatus again as UI would after mutation.
    const secondPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });

    // Step 4: Let microtasks flush so second call evaluates inFlightStatusFetches
    await Promise.resolve();

    // git.getGitStatus should only have been called ONCE — the second
    // fetchStatus hit the inFlightStatusFetches dedup.
    expect(gitStatusCalls).toBe(1);

    // Now resolve the pending deferred
    pending.resolve(makeStatus('main'));
    const results = await Promise.allSettled([firstPromise, secondPromise]);

    // Both promises resolved successfully (the stale data)
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('fulfilled');
  });

  test('stale pre-mutation data overwrites the store after mutation race', async () => {
    // Step 1: Seed initial status (branch = 'main')
    const seedDeferred = createDeferred<GitStatus>();
    const seedGit = createGitApi(async () => seedDeferred.promise);
    const seedPromise = useGitStore.getState().fetchStatus('/repo', seedGit, { silent: true });
    await Promise.resolve();
    seedDeferred.resolve(makeStatus('main'));
    await seedPromise;

    expect(useGitStore.getState().directories.get('/repo')?.status?.current).toBe('main');

    // Step 2: Start a new fetchStatus that will be slow
    const deferred = createDeferred<GitStatus>();
    let gitStatusCalls = 0;
    const git = createGitApi(async () => {
      gitStatusCalls++;
      return deferred.promise;
    });
    const firstPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve(); // flush so IIFE is created and inFlight promise stored

    // Step 3: Simulate mutation (checkout to 'feature'). HTTP-level cache cleared.
    // But inFlightStatusFetches still holds the promise from step 2.
    // UI calls fetchStatus again.
    const secondPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve(); // flush

    // Both calls share the same underlying fetch — only 1 HTTP-level call
    expect(gitStatusCalls).toBe(1);

    // Step 4: The deferred promise resolves with stale data (branch = 'main')
    deferred.resolve(makeStatus('main'));
    await Promise.allSettled([firstPromise, secondPromise]);

    // BUG: Store still shows branch = 'main' (pre-mutation data) instead of 'feature'.
    expect(useGitStore.getState().directories.get('/repo')?.status?.current).toBe('main');
    // If the bug were fixed, the store would have been refreshed with
    // the correct post-mutation state (branch = 'feature') via a fresh fetch.
  });

  test('fetchAll({ force: true }) does NOT force a new status fetch', async () => {
    const calls: Array<{ directory: string; options?: { mode?: 'light' } }> = [];
    const deferred = createDeferred<GitStatus>();
    const git = createGitApi((dir, opts) => {
      calls.push({ directory: dir, options: opts });
      return deferred.promise;
    });

    // Seed initial data
    {
      const d = createDeferred<GitStatus>();
      const g = createGitApi(async () => d.promise);
      const p = useGitStore.getState().fetchStatus('/repo', g, { silent: true });
      await Promise.resolve();
      d.resolve(makeStatus('main'));
      await p;
    }

    // Start a new in-flight fetchStatus
    const statusPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();

    // Now call fetchAll with force:true — docs say "force only affects log refresh"
    const allPromise = useGitStore.getState().fetchAll('/repo', git, { force: true });
    await Promise.resolve();

    // `force` should also force status. Currently it doesn't.
    // Expect 1 call from the initial fetchStatus; fetchAll should also fetch status.
    deferred.resolve(makeStatus('main'));
    await Promise.allSettled([statusPromise, allPromise]);

    // `fetchAll({ force: true })` should trigger a new getGitStatus call.
    // Currently it only deduplicates through inFlightStatusFetches.
    expect(calls.length).toBe(1);
    // A post-fix implementation would result in 2 calls (one from initial fetch,
    // one from fetchAll which bypasses dedup when force=true).
  });
});
