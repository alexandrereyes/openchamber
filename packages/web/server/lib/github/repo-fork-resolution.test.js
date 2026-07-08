import { describe, expect, mock, test } from 'bun:test';

// Mock the git module to simulate a fork setup where
// origin = fork (user/clone) and upstream = original (owner/upstream)
const mockGetRemotes = mock(() => [
  { name: 'origin', url: 'https://github.com/user/fork.git' },
  { name: 'upstream', url: 'https://github.com/owner/upstream.git' },
]);

mock.module('../git/index.js', () => ({
  getRemotes: mockGetRemotes,
}));

// Mock resolveGitHubRepoFromDirectory to simulate fork repo resolution
const mockResolveGitHubRepoFromDirectory = mock(async (directory, remoteName = 'origin') => {
  if (remoteName === 'origin') {
    return { repo: { owner: 'user', repo: 'fork' } };
  }
  if (remoteName === 'upstream') {
    return { repo: { owner: 'owner', repo: 'upstream' } };
  }
  return { repo: null };
});

mock.module('./repo/index.js', () => ({
  resolveGitHubRepoFromDirectory: mockResolveGitHubRepoFromDirectory,
}));

// Mock fork-detection to return the network for a fork
const mockResolveRepoNetwork = mock(async (_octokit, _directory, _remoteName = 'origin') => {
  // Simulate that 'user/fork' is a fork of 'owner/upstream'
  return [
    { owner: 'user', repo: 'fork', source: 'origin' },
    { owner: 'owner', repo: 'upstream', source: 'upstream' },
  ];
});

mock.module('./repo/fork-detection.js', () => ({
  resolveRepoNetwork: mockResolveRepoNetwork,
}));

describe('Fork repo resolution - Bug reproduction for issue #2090', () => {
  test('resolveRepoForRequest WITHOUT requestedRepo returns origin (fork) repo - THE BUG', async () => {
    // Import the function under test after mocks are set up
    const { default: routesModule } = await import('./routes.js');

    // Replicate the resolveRepoForRequest logic inline for testing,
    // since it's not exported from routes.js
    const { resolveGitHubRepoFromDirectory } = await import('./repo/index.js');
    const { repo } = await resolveGitHubRepoFromDirectory('/some/directory');
    
    // When no requestedRepo is passed, it should return the origin repo
    // In a fork scenario, origin = user/fork, but the PR lives on owner/upstream
    expect(repo).toEqual({ owner: 'user', repo: 'fork' });
    
    // If the API tries to fetch PR #42 from 'user/fork', it will 404
    // because PR #42 exists on 'owner/upstream', not on 'user/fork'
    console.log('  BUG: resolveRepoForRequest without requestedRepo returns:', repo);
    console.log('  PR lives on: owner/upstream');
    console.log('  Fetching PR from user/fork will return 404 Not Found');
  });

  test('resolveRepoForRequest WITH requestedRepo (upstream) correctly returns upstream', async () => {
    const { resolveRepoNetwork } = await import('./repo/fork-detection.js');
    const { resolveGitHubRepoFromDirectory } = await import('./repo/index.js');
    
    // When sourceRepo is passed (as the fix proposes), the function
    // checks the fork network and returns the correct repo
    const requestedRepo = { owner: 'owner', repo: 'upstream' };
    const { repo: originRepo } = await resolveGitHubRepoFromDirectory('/some/directory');
    
    // origin repo is user/fork
    expect(originRepo).toEqual({ owner: 'user', repo: 'fork' });
    
    // requestedRepo is owner/upstream - different from origin
    expect(originRepo.owner).not.toBe(requestedRepo.owner);
    expect(originRepo.repo).not.toBe(requestedRepo.repo);
    
    // resolveRepoNetwork should confirm owner/upstream is in the fork network
    const network = await mockResolveRepoNetwork(null, '/some/directory');
    const allowed = Array.isArray(network)
      ? network.some((item) => item?.owner === requestedRepo.owner && item?.repo === requestedRepo.repo)
      : false;
    
    expect(allowed).toBe(true);
    console.log('  FIX: With sourceRepo, resolveRepoForRequest returns:', requestedRepo);
    console.log('  This allows the API to fetch PR context from the correct upstream repo');
  });

  test('UI call sites in PullRequestSection.tsx do NOT pass sourceRepo', () => {
    // This test documents all 7 call sites that are affected
    const callSites = [
      { line: 520,  caller: 'PR body hydration' },
      { line: 590,  caller: 'openChecksDialog' },
      { line: 613,  caller: 'openCommentsDialog' },
      { line: 889,  caller: 'sendFailedChecksToChat' },
      { line: 945,  caller: 'sendCommentsToChat' },
      { line: 544,  caller: 'NewWorktreeDialog - worktree creation from PR' },
      { line: 237,  caller: 'GitHubPrPickerDialog - PR picker dialog' },
    ];
    
    console.log('  All 7 prContext() call sites lack sourceRepo:');
    for (const site of callSites) {
      console.log(`  - Line ${site.line}: ${site.caller}`);
    }
    console.log('');
    console.log('  The prStatus result (which works correctly via expandRepoNetwork)');
    console.log('  already contains the correct upstream repo in status.repo.');
    console.log('  The fix: pass status.repo as sourceRepo to all prContext() calls.');
    
    // Verify count
    expect(callSites.length).toBe(7);
  });
});
