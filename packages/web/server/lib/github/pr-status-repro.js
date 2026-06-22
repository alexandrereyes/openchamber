/**
 * Standalone reproduction script for issue #1771
 *
 * Demonstrates the exact algorithm bug: findFirstMatchingPr exhaustively checks
 * ALL states (open, closed) within ONE target before moving to the next target.
 * This means a closed/merged PR on a higher-priority target (fork) wins over
 * an open PR on a lower-priority target (upstream/main repo).
 *
 * Run: node packages/web/server/lib/github/pr-status-repro.js
 */

// Replicate the relevant logic from pr-status.js to isolate the bug
// without needing to mock Git/Octokit/etc.

const normalizeText = (value) => typeof value === 'string' ? value.trim() : '';
const normalizeLower = (value) => normalizeText(value).toLowerCase();
const normalizeRepoKey = (owner, repo) => {
  const normalizedOwner = normalizeLower(owner);
  const normalizedRepo = normalizeLower(repo);
  if (!normalizedOwner || !normalizedRepo) return '';
  return `${normalizedOwner}/${normalizedRepo}`;
};

// Simulated PRs database
const ALL_PRS = {
  // Fork repo has 1 PR: merged (closed)
  'bashrusakh/openchamber': {
    'plan/test-branch': {
      number: 5,
      title: 'Merged fork PR',
      state: 'closed',
      merged: true,
      head: { ref: 'plan/test-branch', repo: { owner: { login: 'bashrusakh' }, name: 'openchamber' } },
      base: { repo: { owner: { login: 'bashrusakh' }, name: 'openchamber' } },
    },
  },
  // Upstream/main repo has 1 PR: open
  'openchamber/openchamber': {
    'plan/test-branch': {
      number: 1751,
      title: 'Open upstream PR',
      state: 'open',
      merged: false,
      head: { ref: 'plan/test-branch', label: 'bashrusakh:plan/test-branch', repo: { owner: { login: 'bashrusakh' }, name: 'openchamber' } },
      base: { repo: { owner: { login: 'openchamber' }, name: 'openchamber' } },
    },
  },
};

// Simulate the issue reporter's scenario
const branch = 'plan/test-branch';

// The resolvedTargets as built by expandRepoNetwork (sorted by priority)
// Fork (priority 0), Upstream (priority 0.1)
const resolvedTargets = [
  { repo: { owner: 'bashrusakh', repo: 'openchamber' }, remoteName: 'origin', priority: 0 },
  { repo: { owner: 'openchamber', repo: 'openchamber' }, remoteName: 'origin', priority: 0.1 },
];

// Replicate the findFirstMatchingPr logic (lines 386-424)
function simulateFindFirstMatchingPr(target, branch, sourceCandidates) {
  const targetRepoKey = normalizeRepoKey(target.repo.owner, target.repo.repo);

  // Simulate safeListPulls by looking up our PR database
  function simulateSafeListPulls(owner, repo, state, head) {
    const repoKey = normalizeRepoKey(owner, repo);
    const repoPrs = ALL_PRS[repoKey];
    if (!repoPrs) return [];

    const results = [];
    for (const [branchName, pr] of Object.entries(repoPrs)) {
      if (head && `${owner}:${branchName}` !== head) continue;
      if (pr.state !== state) continue;
      if (pr.head.ref !== branch) continue;
      results.push(pr);
    }
    return results;
  }

  const sourceOwners = [];
  sourceCandidates.forEach((candidate) => {
    const owner = normalizeLower(candidate.repo?.owner);
    if (owner && !sourceOwners.includes(owner)) sourceOwners.push(owner);
  });

  // EXACT reproduction of the buggy code (lines 396-421):
  for (const state of ['open', 'closed']) {
    console.log(`  [findFirstMatchingPr] target=${targetRepoKey}, state=${state}`);

    for (const owner of sourceOwners) {
      const directCandidates = simulateSafeListPulls(
        target.repo.owner,
        target.repo.repo,
        state,
        `${owner}:${branch}`
      );
      console.log(`    owner=${owner}: directCandidates=${directCandidates.map(p => `#${p.number}(${p.state})`).join(', ') || 'none'}`);
      if (directCandidates.length > 0) {
        console.log(`    → MATCH: PR #${directCandidates[0].number} (${directCandidates[0].state})`);
        return directCandidates[0];
      }
    }

    // fallback: no head filter
    const fallbackCandidates = simulateSafeListPulls(
      target.repo.owner,
      target.repo.repo,
      state
    );
    console.log(`    fallback: candidates=${fallbackCandidates.map(p => `#${p.number}(${p.state})`).join(', ') || 'none'}`);
    const fallback = fallbackCandidates.filter(pr => pr.head.ref === branch);
    if (fallback.length > 0) {
      console.log(`    → MATCH (fallback): PR #${fallback[0].number} (${fallback[0].state})`);
      return fallback[0];
    }
  }

  return null;
}

// Replicate the resolveGitHubPrStatus loop (lines 466-495)
function simulateResolveGitHubPrStatus() {
  const sourceCandidates = resolvedTargets.slice();

  console.log('\n=== Simulating resolveGitHubPrStatus ===\n');
  console.log(`Branch: ${branch}`);
  console.log(`Targets (in priority order):`);
  resolvedTargets.forEach(t => console.log(`  ${normalizeRepoKey(t.repo.owner, t.repo.repo)} (priority ${t.priority})`));

  // The buggy loop (lines 466-495):
  for (const target of resolvedTargets) {
    const targetKey = normalizeRepoKey(target.repo.owner, target.repo.repo);
    console.log(`\n--- Checking target: ${targetKey} ---`);

    const pr = simulateFindFirstMatchingPr(target, branch, sourceCandidates);
    if (pr) {
      console.log(`\n*** RESULT: PR #${pr.number} "${pr.title}" (${pr.state}) from ${targetKey} ***`);
      console.log(`*** This is the BUG: an open PR on upstream was never checked. ***`);
      return pr;
    }
  }

  console.log('\nNo PR found');
  return null;
}

console.log('='.repeat(70));
console.log('REPRODUCTION: GitHub Issue #1771');
console.log('Git tab shows merged fork PR instead of open upstream PR');
console.log('='.repeat(70));

const result = simulateResolveGitHubPrStatus();

console.log('\n' + '='.repeat(70));
console.log('EXPECTED: PR #1751 "Open upstream PR" (open) from openchamber/openchamber');
console.log('ACTUAL:   PR #5 "Merged fork PR" (closed) from bashrusakh/openchamber');
console.log('='.repeat(70));

if (result && result.number === 5) {
  console.log('\n✓ BUG CONFIRMED: The merged fork PR (#5) was returned instead of the open upstream PR (#1751)');
  console.log('\nRoot cause: findFirstMatchingPr checks ALL states (open, closed) within one target');
  console.log('before moving to the next target. Since fork has priority 0 (checked first),');
  console.log('a closed PR on the fork wins over an open PR on upstream (priority 0.1).');
  console.log('\nFix: Collect all open PR candidates across ALL targets first. Only fall back');
  console.log('to closed/merged if no open candidate exists in any target.');
  process.exit(0);
} else {
  console.log('\n✗ Bug not reproduced as expected');
  process.exit(1);
}
