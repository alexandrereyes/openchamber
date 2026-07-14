/**
 * Reproduction for issue #2247:
 * The red shield icon for manual approval (pendingPermissionCount) does not show
 * on a parent session when one of its subagent children has pending permission requests.
 *
 * Root cause: SessionNodeItem computes `pendingPermissionCount` from
 * `useSessionPermissions(session.id, ...)`, which only looks up permissions
 * keyed by the current session's ID. It never aggregates permissions from
 * child/subagent sessions.
 */

import { describe, expect, test } from 'bun:test';

// --- Types mirroring the real PermissionRequest ---
interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

// --- Simulated store shape (mirrors sync-context.tsx State.permission) ---
type PermissionStore = Record<string, PermissionRequest[]>;

// --- The current (buggy) behavior: only looks up the given session ID ---
function getPendingPermissionCountCurrent(
  store: PermissionStore,
  sessionID: string,
): number {
  return (store[sessionID] ?? []).length;
}

// --- Expected behavior: also recursively aggregate children's permissions ---
function getPendingPermissionCountExpected(
  store: PermissionStore,
  sessionID: string,
  childrenByParent: Map<string, string[]>,
): number {
  let count = (store[sessionID] ?? []).length;
  const childIDs = childrenByParent.get(sessionID) ?? [];
  for (const childID of childIDs) {
    count += getPendingPermissionCountExpected(store, childID, childrenByParent);
  }
  return count;
}

describe('Issue #2247 – shield icon does not appear on parent when subagent needs approval', () => {
  test('BUG: parent session has zero pending permissions when only children have them', () => {
    // Arrange: a parent session with two children (subagents)
    const parentID = 'session_parent';
    const childA = 'session_child_a';
    const childB = 'session_child_b';

    // Parent-child tree
    const childrenByParent = new Map<string, string[]>();
    childrenByParent.set(parentID, [childA, childB]);

    // Store: only children have pending permission requests
    const store: PermissionStore = {
      [childA]: [
        {
          id: 'perm_1',
          sessionID: childA,
          permission: 'read',
          patterns: ['src/**'],
          metadata: {},
          always: [],
        },
      ],
      [childB]: [
        {
          id: 'perm_2',
          sessionID: childB,
          permission: 'write',
          patterns: ['src/**'],
          metadata: {},
          always: [],
        },
        {
          id: 'perm_3',
          sessionID: childB,
          permission: 'read',
          patterns: ['config/**'],
          metadata: {},
          always: [],
        },
      ],
    };

    // Act: current behavior
    const currentCount = getPendingPermissionCountCurrent(store, parentID);

    // Assert: current code returns 0 (does not see children)
    expect(currentCount).toBe(0);
    // This is the bug — the parent should show the aggregated count

    // Act: expected behavior (aggregating children)
    const expectedCount = getPendingPermissionCountExpected(store, parentID, childrenByParent);

    // Assert: expected would return 3 (childA has 1, childB has 2)
    expect(expectedCount).toBe(3);
  });

  test('parent session correctly shows its own direct permissions', () => {
    // This case works correctly today
    const parentID = 'session_parent';
    const store: PermissionStore = {
      [parentID]: [
        {
          id: 'perm_4',
          sessionID: parentID,
          permission: 'read',
          patterns: ['src/**'],
          metadata: {},
          always: [],
        },
      ],
    };

    const count = getPendingPermissionCountCurrent(store, parentID);
    expect(count).toBe(1);
  });
});
