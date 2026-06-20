/**
 * Reproduction test for issue #1736: Branch filter in worktree creation shows
 * non-matching branches after matches.
 *
 * Bug: `rankBranchesForQuery` always returns ALL non-matching branches in
 * `otherLocal` / `otherRemote`, even when a query is active. The component
 * (`NewWorktreeDialog.tsx`) then renders them under "Other local branches" /
 * "Other remote branches" headings, which defeats the purpose of filtering.
 *
 * Expected behavior when a query is active:
 *   - `matching` contains branches that fuzzy-match the query
 *   - `otherLocal` and `otherRemote` should be empty
 *
 * Actual (buggy) behavior:
 *   - `matching` contains matching branches (correct)
 *   - `otherLocal` and `otherRemote` still contain ALL non-matching branches
 *     (bug — defeats the filter)
 */
import { describe, expect, test } from 'bun:test';
import { rankBranchesForQuery } from './branchSearch';

const localBranches = [
  'main',
  'develop',
  'feature/login-page',
  'feature/logout-page',
  'fix/typo-in-readme',
  'chore/update-deps',
  'release/v1.0',
  'release/v2.0',
  'experiment/wip-stuff',
  'old/legacy-branch',
];

const remoteBranches = [
  'origin/main',
  'origin/develop',
  'origin/feature/login-page',
  'origin/release/v1.0',
  'origin/other/remote-only',
];

describe('rankBranchesForQuery — issue #1736', () => {

  test('without a query, all branches are in otherLocal / otherRemote', () => {
    const result = rankBranchesForQuery({
      localBranches,
      remoteBranches,
      query: '',
    });

    expect(result.matching).toEqual([]);
    expect(result.otherLocal).toEqual(localBranches);
    expect(result.otherRemote).toEqual(remoteBranches);
  });

  test('BUG: with a matching query, non-matching branches leak into other*', () => {
    // "wip-stuff" only matches "experiment/wip-stuff"
    const query = 'wip-stuff';
    const result = rankBranchesForQuery({
      localBranches,
      remoteBranches,
      query,
    });

    // Matching is correct — "experiment/wip-stuff" is in matching
    expect(result.matching.length).toBeGreaterThan(0);
    expect(result.matching.some(b => b.label === 'experiment/wip-stuff')).toBe(true);

    // BUG: otherLocal and otherRemote are still populated with ALL non-matching branches
    // They should be empty when a query is active, but they aren't.
    expect(result.otherLocal.length).toBeGreaterThan(0);
    expect(result.otherRemote.length).toBeGreaterThan(0);

    // With a proper filter, these should both be empty
    const localMatchLabels = new Set(result.matching.filter(b => b.source === 'local').map(b => b.label));
    const expectedOtherLocal = localBranches.filter(b => !localMatchLabels.has(b));
    expect(result.otherLocal).toEqual(expectedOtherLocal);
  });

  test('BUG: with zero matches, other* buckets still contain every branch', () => {
    const query = 'zzzz_nonexistent_12345';
    const result = rankBranchesForQuery({
      localBranches,
      remoteBranches,
      query,
    });

    // Zero matches (query too specific)
    expect(result.matching).toEqual([]);

    // BUG: Despite zero matches, otherLocal and otherRemote contain ALL branches
    expect(result.otherLocal.length).toBeGreaterThan(0);
    expect(result.otherRemote.length).toBeGreaterThan(0);

    // With zero matches + active query, the component shows "No matching branches"
    // but the other* buckets are still full, so the user sees both empty-state
    // AND the full branch list below it — defeating the filter.
  });
});
