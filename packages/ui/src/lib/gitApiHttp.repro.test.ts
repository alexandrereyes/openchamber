/**
 * Reproduction tests for issue #2281:
 * Post-mutation status refresh does not invalidate after several status-affecting
 * operations including branch checkout/create/rename/delete, stash create/apply/pop/drop,
 * merge/rebase lifecycle actions, and history actions (checkout-commit/cherry-pick/revert/reset).
 *
 * These tests prove that `invalidateGitStatusCache` is NOT called after successful
 * mutations in the affected functions, so a subsequent `getGitStatus` returns stale
 * cached data instead of making a fresh network request.
 */
import { describe, expect, test } from 'bun:test';
import {
  getGitStatus,
  checkoutBranch,
  createBranch,
  renameBranch,
  deleteGitBranch,
  stashGitChanges,
  applyGitStash,
  popGitStash,
  dropGitStash,
  rebase,
  abortRebase,
  continueRebase,
  merge,
  abortMerge,
  continueMerge,
  checkoutCommit,
  cherryPick,
  revertCommit,
  resetToCommit,
  gitFetch,
} from './gitApiHttp';

/** Count how many times /api/git/status is requested for a given directory prefix. */
const installMockFetch = (directory: string) => {
  const statusCalls: Array<{ url: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(`/api/git/status`) && url.includes(encodeURIComponent(directory))) {
      statusCalls.push({ url });
      return new Response(
        JSON.stringify({
          current: 'main',
          tracking: null,
          ahead: 0,
          behind: 0,
          files: [],
          isClean: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // All non-status requests succeed without side effects
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return statusCalls;
};

/** Ensure a fresh status cache before each sub-test by seeding then reading. */
const seedStatus = async (directory: string) => {
  await getGitStatus(directory);
};

const DIR = '/repo-2281';

// ---------------------------------------------------------------------------
// Category 1: Branch operations
// ---------------------------------------------------------------------------
describe('Missing invalidations – Branch operations (issue #2281)', () => {
  test('checkoutBranch does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await checkoutBranch(DIR, 'other-branch');

    // After checkout, getGitStatus should re-fetch if cache was invalidated.
    // If it returns stale data without a new network request, invalidation is missing.
    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
    // A NEW network request would have incremented statusCalls.
    // Same count means the cached (pre-checkout) value was returned.
  });

  test('createBranch does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await createBranch(DIR, 'feature/new');

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('renameBranch does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await renameBranch(DIR, 'old-name', 'new-name');

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('deleteGitBranch does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await deleteGitBranch(DIR, { branch: 'feature/old' });

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Category 2: Stash operations
// ---------------------------------------------------------------------------
describe('Missing invalidations – Stash operations (issue #2281)', () => {
  test('stashGitChanges does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await stashGitChanges(DIR, { message: 'WIP' });

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('applyGitStash does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await applyGitStash(DIR, { ref: 'stash@{0}' });

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('popGitStash does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await popGitStash(DIR, { ref: 'stash@{0}' });

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('dropGitStash does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await dropGitStash(DIR, { ref: 'stash@{0}' });

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Category 3: Merge / rebase lifecycle
// ---------------------------------------------------------------------------
describe('Missing invalidations – Merge/rebase lifecycle (issue #2281)', () => {
  test('rebase does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await rebase(DIR, { onto: 'main' });

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('abortRebase does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await abortRebase(DIR);

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('continueRebase does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await continueRebase(DIR);

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('merge does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await merge(DIR, { branch: 'feature' });

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('abortMerge does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await abortMerge(DIR);

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('continueMerge does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await continueMerge(DIR);

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Category 4: History operations (checkout-commit, cherry-pick, revert, reset)
// ---------------------------------------------------------------------------
describe('Missing invalidations – History operations (issue #2281)', () => {
  test('checkoutCommit does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await checkoutCommit(DIR, 'abc123');

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('cherryPick does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await cherryPick(DIR, 'abc123');

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('revertCommit does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await revertCommit(DIR, 'abc123');

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });

  test('resetToCommit does NOT invalidate cached status', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await resetToCommit(DIR, 'abc123', 'mixed');

    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Positive control: gitFetch DOES invalidate (existing correct behavior)
// ---------------------------------------------------------------------------
describe('Positive control – gitFetch correctly invalidates (issue #2281)', () => {
  test('gitFetch invalidates cached status (pre-existing correct behavior)', async () => {
    const statusCalls = installMockFetch(DIR);
    await seedStatus(DIR);
    const callsBefore = statusCalls.length;

    await gitFetch(DIR, { remote: 'origin' });

    // After invalidate, getGitStatus should make a new HTTP request
    await getGitStatus(DIR);
    expect(statusCalls.length).toBe(callsBefore + 1);
  });
});
