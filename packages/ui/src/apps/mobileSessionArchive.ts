import type { Session } from '@opencode-ai/sdk/v2/client';

import { computeSubtreeIds } from '@/sync/scoped-blocking-requests';

const isArchived = (session: Session): boolean => Boolean(session.time?.archived);

export type ArchiveSessionsResult = { archivedIds: string[]; failedIds: string[] };

type ArchiveSessionsFn = (
  ids: string[],
  options?: { expectedRuntimeKey?: string },
) => Promise<ArchiveSessionsResult>;

/**
 * IDs to archive when a mobile session row is swiped: the row itself plus every
 * known active descendant, root first.
 *
 * OpenCode does not cascade `time.archived` to subagents, so archiving only the
 * swiped row leaves its children listed under a parent that is gone.
 *
 * `sessions` is a lineage snapshot, so it may include archived records:
 * traversal passes *through* an archived intermediate to reach active sessions
 * below it, while archived sessions themselves are dropped from the targets so
 * they are not re-timestamped. That mirrors the desktop sidebar cascade. The
 * root is always kept — including when it is absent from `sessions` — so the
 * swipe archives the row the user acted on.
 */
export const collectMobileArchiveTargetIds = (sessions: Session[], rootId: string): string[] => {
  const subtreeIds = computeSubtreeIds(sessions, rootId);
  const archivedIds = new Set(sessions.filter(isArchived).map((session) => session.id));
  return [...subtreeIds].filter((id) => id === rootId || !archivedIds.has(id));
};

/**
 * Archives a swiped mobile row and its known active subtree.
 *
 * Deepest first, root last: a session is never archived while one of its own
 * descendants is still active. So when a descendant fails, the batch stops
 * before the ancestors and the tree stays coherent and retryable instead of
 * leaving the orphaned children this cascade exists to prevent.
 *
 * Every call is pinned to `expectedRuntimeKey`, captured by the caller when the
 * swipe was handled, so a runtime switch mid-batch stops the work instead of
 * archiving these IDs against a different runtime.
 *
 * `failedIds` reports what is still active, including ancestors that were
 * deliberately not attempted.
 */
export const archiveMobileSessionSubtree = async (args: {
  sessions: Session[];
  rootId: string;
  expectedRuntimeKey: string;
  archiveSessions: ArchiveSessionsFn;
}): Promise<ArchiveSessionsResult & { targetCount: number }> => {
  const targetIds = collectMobileArchiveTargetIds(args.sessions, args.rootId);
  const [rootId, ...descendantIds] = targetIds;
  const targetCount = targetIds.length;
  const options = { expectedRuntimeKey: args.expectedRuntimeKey };

  // `computeSubtreeIds` walks breadth-first, so every parent precedes its own
  // children; reversing that order archives each session only after the subtree
  // beneath it.
  const descendants = descendantIds.length > 0
    ? await args.archiveSessions([...descendantIds].reverse(), options)
    : { archivedIds: [], failedIds: [] };

  if (descendants.failedIds.length > 0) {
    return {
      archivedIds: descendants.archivedIds,
      failedIds: [...descendants.failedIds, rootId],
      targetCount,
    };
  }

  const root = await args.archiveSessions([rootId], options);
  return {
    archivedIds: [...descendants.archivedIds, ...root.archivedIds],
    failedIds: root.failedIds,
    targetCount,
  };
};
