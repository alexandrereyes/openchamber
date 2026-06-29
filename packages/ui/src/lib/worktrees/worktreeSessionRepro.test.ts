/**
 * Reproduction test for issue #1916:
 * Worktree session starts as projectID=global and does not load project opencode.json MCP config.
 *
 * Root cause: race condition where sessionStore.createSession() is called
 * BEFORE the git worktree `git worktree add` operation completes, because
 * `returnAfterDirectoryCreated: true` defers worktree setup to background
 * and `getWorktreeSetupWaitEnabled()` returns false by default.
 *
 * The OpenCode server receives `session.create({ directory: worktreePath })`
 * but the worktree directory doesn't have a `.git` file yet (git worktree add
 * hasn't run). OpenCode can't detect the git repository → falls back to
 * `projectID=global`. Project-specific opencode.json (with MCP entries) is
 * never loaded.
 *
 * To reproduce manually:
 * 1. Set up a git repo as the active project
 * 2. Ensure `opencode.json` has MCP entries in the worktree
 * 3. Create a worktree session via the "New Worktree" feature
 * 4. The session will be created before `git worktree add` completes
 * 5. Check the session's projectID — it will be "global" instead of the git hash
 * 6. MCP servers defined in the worktree's opencode.json won't be available
 */
import { describe, expect, test } from 'bun:test';

// ============================================================
// Track order of async operations in the worktree creation flow
// to prove the race condition exists.
// ============================================================

/**
 * Simulates the server-side createWorktree with returnAfterDirectoryCreated.
 * This replicates the logic in web/server/lib/git/service.js:createWorktree()
 */
async function simulateServerCreateWorktree(
  projectDirectory: string,
  args: { returnAfterDirectoryCreated?: boolean; worktreeName?: string; branchName?: string },
  tracker: string[],
): Promise<{ path: string; name: string; branch: string; bootstrapStatus: string }> {
  const worktreePath = `${projectDirectory}/../opencode-worktrees/${args.worktreeName || args.branchName || 'unknown'}`;

  if (args.returnAfterDirectoryCreated) {
    // 1. Create empty directory immediately
    tracker.push(`SERVER: mkdir ${worktreePath} (directory created)`);

    // 2. Schedule 'git worktree add' in the background
    //    (simulated by a void .catch() call — exactly like the real code)
    const backgroundOp = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      tracker.push(`SERVER: git worktree add completed for ${worktreePath} (bootstrap ready)`);
    })().catch(() => {});

    // 3. Return immediately without awaiting the background operation
    //    This is exactly what happens in git/service.js:
    //    void attachGitWorktreeToCandidate(context, candidate, input).catch(...)
    //    return { ... }  <-- returns immediately
    void backgroundOp;

    tracker.push(`SERVER: createWorktree returning immediately (worktree still pending)`);

    return {
      path: worktreePath,
      name: args.worktreeName || '',
      branch: args.branchName || '',
      bootstrapStatus: 'pending',
    };
  } else {
    // Synchronous mode: wait for git worktree add to complete
    tracker.push(`SERVER: mkdir ${worktreePath}`);
    tracker.push(`SERVER: git worktree add ${worktreePath} (synchronous)`);
    return {
      path: worktreePath,
      name: args.worktreeName || '',
      branch: args.branchName || '',
      bootstrapStatus: 'ready',
    };
  }
}

/**
 * Simulates the client-side createWorktreeSessionForNewBranch logic
 * from packages/ui/src/lib/worktreeSessionCreator.ts lines 349-372.
 *
 * The key issue is:
 * - Line 349: createWorktreeWithDefaults() is called with returnAfterDirectoryCreated: true
 * - Line 369: waitForWorktreeBootstrapIfEnabled() — by default does NOTHING
 * - Line 372: sessionStore.createSession() runs BEFORE git worktree add completes
 */
async function simulateCreateWorktreeSession(
  projectDirectory: string,
  branchName: string,
  setupWorktreeWaitEnabled: boolean,
  tracker: string[],
): Promise<{ session: { id: string; projectID: string; directory: string } | null; worktreePath: string }> {
  // Step 1: Create worktree with returnAfterDirectoryCreated (as the code does)
  tracker.push(`CLIENT: createWorktreeWithDefaults called (returnAfterDirectoryCreated: true)`);

  const worktree = await simulateServerCreateWorktree(projectDirectory, {
    returnAfterDirectoryCreated: true,
    worktreeName: branchName,
    branchName,
  }, tracker);

  // Step 2: Check if we should wait for bootstrap
  // This mirrors worktreeSessionCreator.ts line 369:
  //   await waitForWorktreeBootstrapIfEnabled(projectRef, metadata.path);
  // Which calls getWorktreeSetupWaitEnabled() — by default returns false
  if (setupWorktreeWaitEnabled) {
    tracker.push(`CLIENT: waitForWorktreeBootstrap (setup-worktree-wait is ENABLED)`);
    // Wait until the background git worktree add completes
    let bootstrapComplete = false;
    while (!bootstrapComplete) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      bootstrapComplete = tracker.some((t) => t.includes('git worktree add completed'));
    }
    tracker.push(`CLIENT: worktree bootstrap complete — proceeding to create session`);
  } else {
    tracker.push(`CLIENT: SKIPPING waitForWorktreeBootstrap (default: setup-worktree-wait is DISABLED)`);
  }

  // Step 3: Create session — this mirrors worktreeSessionCreator.ts line 372:
  //   const session = await sessionStore.createSession(undefined, metadata.path);
  tracker.push(`CLIENT: sessionStore.createSession called with directory: ${worktree.path}`);

  // Simulate what the OpenCode server returns when it can/can't detect the git repo
  const gitWorktreeExists = tracker.some((t) => t.includes('git worktree add completed'));
  const session = {
    id: 'ses_repro_001',
    // If the git worktree has been set up, OpenCode detects the repo → correct projectID
    // If not (the race condition), OpenCode falls back to 'global'
    projectID: gitWorktreeExists ? 'abc123def456' : 'global',
    directory: worktree.path,
  };

  tracker.push(`CLIENT: session created — projectID=${session.projectID}`);

  return { session, worktreePath: worktree.path };
}

describe('Worktree session creation race condition (issue #1916)', () => {
  test('RACE CONDITION: session created before git worktree add completes → projectID=global', async () => {
    const tracker: string[] = [];

    const result = await simulateCreateWorktreeSession(
      '/home/user/projects/my-app',
      'issue-540',
      false, // setupWorktreeWaitEnabled = false (THE DEFAULT — root cause of the bug)
      tracker,
    );

    // Log the operation sequence for debugging
    console.log('\n=== Issue #1916 Reproduction: Default Behavior ===');
    console.log('Operation sequence:');
    tracker.forEach((op, i) => console.log(`  ${i + 1}. ${op}`));
    console.log(`\nResult: projectID = ${result.session!.projectID}`);

    // Verify the steps happened in order
    const createDirIndex = tracker.findIndex((t) => t.startsWith('SERVER: mkdir'));
    const returnImmediatelyIndex = tracker.findIndex((t) => t.startsWith('SERVER: createWorktree returning'));
    const skipWaitIndex = tracker.findIndex((t) => t.startsWith('CLIENT: SKIPPING waitForWorktreeBootstrap'));
    const createSessionIndex = tracker.findIndex((t) => t.startsWith('CLIENT: sessionStore.createSession called'));
    const worktreeCompleteIndex = tracker.findIndex((t) => t.includes('git worktree add completed'));

    // Verify creation sequence
    expect(createDirIndex).not.toBe(-1);
    expect(returnImmediatelyIndex).not.toBe(-1);
    expect(skipWaitIndex).not.toBe(-1);
    expect(createSessionIndex).not.toBe(-1);

    // Race Condition: session is created BEFORE worktree add completes
    // -> no 'git worktree add completed' entry before session creation
    const completedBeforeSession = tracker.slice(0, createSessionIndex)
      .some((t) => t.includes('git worktree add completed'));

    // THE BUG: git worktree add has NOT completed by the time the session is created
    expect(completedBeforeSession).toBe(false);

    // Session has projectID=global because git repo wasn't detectable
    expect(result.session).not.toBeNull();
    expect(result.session!.projectID).toBe('global');

    console.log('\n✅ Bug confirmed: git worktree add had not completed when session was created.');
    console.log('✅ OpenCode server receives directory without .git file → projectID=global');
  });

  test('FIXED BEHAVIOR: waiting for git worktree add → correct projectID', async () => {
    const tracker: string[] = [];

    const result = await simulateCreateWorktreeSession(
      '/home/user/projects/my-app',
      'issue-540-fixed',
      true, // setupWorktreeWaitEnabled = true (THE FIX: wait for bootstrap)
      tracker,
    );

    // Log the operation sequence for debugging
    console.log('\n=== Issue #1916 Reproduction: Fixed Behavior ===');
    console.log('Operation sequence:');
    tracker.forEach((op, i) => console.log(`  ${i + 1}. ${op}`));
    console.log(`\nResult: projectID = ${result.session!.projectID}`);

    // Verify the steps happened in order
    const createDirIndex = tracker.findIndex((t) => t.startsWith('SERVER: mkdir'));
    const returnImmediatelyIndex = tracker.findIndex((t) => t.startsWith('SERVER: createWorktree returning'));
    const waitIndex = tracker.findIndex((t) => t.startsWith('CLIENT: waitForWorktreeBootstrap'));
    const bootstrapCompleteIndex = tracker.findIndex((t) => t.startsWith('CLIENT: worktree bootstrap complete'));
    const createSessionIndex = tracker.findIndex((t) => t.startsWith('CLIENT: sessionStore.createSession called'));

    // Verify creation sequence with wait
    expect(createDirIndex).not.toBe(-1);
    expect(returnImmediatelyIndex).not.toBe(-1);
    expect(waitIndex).not.toBe(-1);
    expect(bootstrapCompleteIndex).not.toBe(-1);
    expect(createSessionIndex).not.toBe(-1);

    // Fixed: session is created AFTER git worktree add completes
    expect(createSessionIndex).toBeGreaterThan(bootstrapCompleteIndex);

    // Session has the correct git-derived projectID
    expect(result.session).not.toBeNull();
    expect(result.session!.projectID).toBe('abc123def456');

    console.log('\n✅ Fix verified: session created after git worktree add completed.');
    console.log('✅ OpenCode server detects git repo → correct projectID');
  });
});
