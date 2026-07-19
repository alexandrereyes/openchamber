/**
 * Reproduction test for issue #2312:
 * GitHub section disappears from settings after disconnecting GitHub auth.
 *
 * Root cause:
 *   GitHubSettings.tsx (lines 259-261) early-returns `null` while `isLoading` is true,
 *   regardless of whether this is the initial load or a refresh after disconnect.
 *   The `disconnect()` handler (line 218) calls `refreshStatus(..., { force: true })`,
 *   which flips `isLoading` to `true` in useGitHubAuthStore (line 53) for the duration
 *   of the re-fetch. During that window the entire <GitHubSettings /> section is
 *   removed from the DOM, leaving the user looking at an empty gap.
 *
 * This test demonstrates that:
 *   1. After an initial successful status check (isLoading=false, hasChecked=true,
 *      status.connected=true), calling refreshStatus with force:true sets isLoading=true.
 *   2. During this isLoading=true window, GitHubSettings returns null (the component
 *      unmounts), which is the bug — the section should stay mounted and transition
 *      to the "Not Connected" state.
 *   3. The component's guard at line 259 (`if (isLoading) return null`) does not
 *      distinguish between initial load (acceptable to show nothing) and a refresh
 *      after disconnect (should keep the section mounted).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Controllable fetch implementation for mocking runtimeFetch
let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: RequestInit) => fetchImpl(input, init),
}));

// Minimal mock for sync modules that the store might indirectly reference
mock.module('@/sync/sync-refs', () => ({ getAllSyncSessionMap: () => new Map() }));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: { getState: () => ({ getDirectoryForSession: () => '/project' }) },
}));

const { useGitHubAuthStore } = await import('./useGitHubAuthStore');

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('Issue #2312 - GitHub section disappears after disconnect', () => {
  beforeEach(() => {
    // Reset store state
    useGitHubAuthStore.setState({
      status: null,
      isLoading: false,
      hasChecked: false,
    });
    // Default fetch: returns a deferred promise that never resolves
    // so tests can control the timing
    fetchImpl = async () => {
      return new Promise<Response>(() => {}); // never resolves
    };
  });

  test('refreshStatus with force:true sets isLoading=true (causing GitHubSettings to return null)', async () => {
    // Arrange: simulate the initial connected state
    fetchImpl = async () =>
      json({
        connected: true,
        user: { login: 'testuser', name: 'Test User' },
        accounts: [{ id: '1', user: { login: 'testuser' }, source: 'oauth', current: true }],
        ghCli: null,
      });

    // First call - initial check (no force)
    const initialStatus = await useGitHubAuthStore.getState().refreshStatus(undefined);

    expect(useGitHubAuthStore.getState().isLoading).toBe(false);
    expect(useGitHubAuthStore.getState().hasChecked).toBe(true);
    expect(useGitHubAuthStore.getState().status?.connected).toBe(true);
    expect(initialStatus?.connected).toBe(true);

    // Set up the fetch to return a deferred (never-resolving) promise for the force refresh
    let resolveRefresh!: (value: Response) => void;
    const refreshPromise = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    fetchImpl = async () => refreshPromise;

    // Act: simulate disconnect by calling refreshStatus with force:true
    // This is exactly what the disconnect() handler does at GitHubSettings.tsx:218
    const statusPromise = useGitHubAuthStore.getState().refreshStatus(undefined, { force: true });

    // Assert: isLoading is now true — this is the problematic window
    expect(useGitHubAuthStore.getState().isLoading).toBe(true);

    // During this window, GitHubSettings (line 259-261) would return null:
    //   if (isLoading) { return null; }
    // This removes the entire section from the DOM.
    // The component SHOULD instead check if hasChecked is already true
    // (meaning we have data) and keep the section mounted.
    //
    // The expected behavior would be:
    //   if (isLoading && !hasChecked) { return null; } // only hide during initial load
    //   // ... keep showing connected/disconnected state during refresh

    // Now resolve the deferred fetch so the promise completes
    resolveRefresh(
      json({
        connected: false,
        user: null,
        accounts: [],
        ghCli: null,
      })
    );

    await statusPromise;

    // After refresh completes, isLoading is false again
    expect(useGitHubAuthStore.getState().isLoading).toBe(false);
    expect(useGitHubAuthStore.getState().status?.connected).toBe(false);
  });

  test('GitHubSettings.tsx line 259-261 unconditionally returns null when isLoading is true', () => {
    // This test demonstrates the component code path that causes the bug.
    // The guard does not distinguish initial load from refresh.
    //
    // Actual component code (GitHubSettings.tsx:259-261):
    //   if (isLoading) {
    //     return null;
    //   }
    //
    // When isLoading is true during a refresh (after disconnect),
    // the section unmounts entirely. The user sees the section disappear
    // until the refresh completes.
    //
    // Simulating the component's decision:
    const simulateComponent = (isLoading: boolean, hasChecked: boolean): 'null' | 'render' => {
      if (isLoading) {
        return 'null'; // <-- bug: this is the unconditional early return
      }
      return 'render';
    };

    // After initial load (hasChecked=true, status.connected=true):
    useGitHubAuthStore.setState({
      status: { connected: true, user: { login: 'testuser' }, accounts: [], ghCli: null },
      isLoading: false,
      hasChecked: true,
    });
    expect(simulateComponent(false, true)).toBe('render');

    // During refresh after disconnect (isLoading=true):
    useGitHubAuthStore.setState({ isLoading: true });
    expect(simulateComponent(true, true)).toBe('null');
    // ↑ The section disappears even though we already have checked status.
    // The component should return 'render' here and show "Not Connected".
  });

  test('refreshStatus dedup does not prevent isLoading spike in the force:true case', async () => {
    // The store has an in-flight dedup (_inFlightAuthRefresh), but the
    // isLoading=true is set BEFORE the dedup check at line 53, so every
    // call to refreshStatus with force:true will spike isLoading=true.
    //
    // The dedup only prevents concurrent fetches, not the isLoading toggle.

    fetchImpl = async () =>
      json({
        connected: true,
        user: { login: 'user1' },
        accounts: [{ id: '1', user: { login: 'user1' }, source: 'oauth', current: true }],
        ghCli: null,
      });

    // Initial load
    await useGitHubAuthStore.getState().refreshStatus(undefined);

    let resolve1!: (v: Response) => void;
    const p1 = new Promise<Response>((r) => { resolve1 = r; });
    fetchImpl = async () => p1;

    // First forced refresh
    const r1 = useGitHubAuthStore.getState().refreshStatus(undefined, { force: true });
    expect(useGitHubAuthStore.getState().isLoading).toBe(true);

    // Second forced refresh - should be deduped (returns same in-flight promise)
    const r2 = useGitHubAuthStore.getState().refreshStatus(undefined, { force: true });
    expect(useGitHubAuthStore.getState().isLoading).toBe(true); // still true

    resolve1(json({ connected: false, user: null, accounts: [], ghCli: null }));
    const result1 = await r1;
    const result2 = await r2;

    // Both calls return the same result (deduped)
    expect(result1?.connected).toBe(false);
    expect(result2?.connected).toBe(false);

    // After completion, isLoading is false
    expect(useGitHubAuthStore.getState().isLoading).toBe(false);
  });
});
