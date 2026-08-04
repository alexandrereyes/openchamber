import type { Session } from '@opencode-ai/sdk/v2/client';

import { computeSubtreeIds } from '@/sync/scoped-blocking-requests';

const isArchived = (session: Session): boolean => Boolean(session.time?.archived);

export type ArchiveSessionsResult = { archivedIds: string[]; failedIds: string[] };

type ArchiveSessionsFn = (
  ids: string[],
  options?: { expectedRuntimeKey?: string },
) => Promise<ArchiveSessionsResult>;

type MobileArchiveTopology = {
  targetIds: string[];
  depthById: Map<string, number>;
  parentsByChild: Map<string, Set<string>>;
};

export const excludeArchivedMobileSessions = (
  sessions: Session[],
  archivedSessions: Session[],
): Session[] => {
  const archivedIds = new Set(archivedSessions.map((session) => session.id));
  return sessions.filter((session) => !isArchived(session) && !archivedIds.has(session.id));
};

const buildMobileArchiveTopology = (sessions: Session[], rootId: string): MobileArchiveTopology => {
  const subtreeIds = computeSubtreeIds(sessions, rootId);
  const archivedIds = new Set(sessions.filter(isArchived).map((session) => session.id));
  const childrenByParent = new Map<string, Set<string>>();
  const parentsByChild = new Map<string, Set<string>>();

  for (const session of sessions) {
    if (!session.parentID || !subtreeIds.has(session.id)) continue;
    const children = childrenByParent.get(session.parentID) ?? new Set<string>();
    children.add(session.id);
    childrenByParent.set(session.parentID, children);
    const parents = parentsByChild.get(session.id) ?? new Set<string>();
    parents.add(session.parentID);
    parentsByChild.set(session.id, parents);
  }

  const depthById = new Map<string, number>([[rootId, 0]]);
  const queue = [rootId];
  for (const id of queue) {
    const depth = depthById.get(id) ?? 0;
    for (const childId of childrenByParent.get(id) ?? []) {
      if (depthById.has(childId)) continue;
      depthById.set(childId, depth + 1);
      queue.push(childId);
    }
  }

  return {
    targetIds: [...subtreeIds].filter((id) => id === rootId || !archivedIds.has(id)),
    depthById,
    parentsByChild,
  };
};

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
  return buildMobileArchiveTopology(sessions, rootId).targetIds;
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
  const topology = buildMobileArchiveTopology(args.sessions, args.rootId);
  const targetIds = topology.targetIds;
  const targetCount = targetIds.length;
  const options = { expectedRuntimeKey: args.expectedRuntimeKey };
  const idsByDepth = new Map<number, string[]>();
  for (const id of targetIds) {
    const depth = topology.depthById.get(id) ?? 0;
    const ids = idsByDepth.get(depth) ?? [];
    ids.push(id);
    idsByDepth.set(depth, ids);
  }

  const archivedIds: string[] = [];
  const failedIds: string[] = [];
  const blockedAncestorIds = new Set<string>();

  const blockAncestors = (failedId: string) => {
    const visited = new Set([failedId]);
    const queue = [failedId];
    for (const id of queue) {
      for (const parentId of topology.parentsByChild.get(id) ?? []) {
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        blockedAncestorIds.add(parentId);
        queue.push(parentId);
      }
    }
  };

  const depths = [...idsByDepth.keys()].sort((left, right) => right - left);
  for (const depth of depths) {
    const ids = idsByDepth.get(depth) ?? [];
    const blockedIds = ids.filter((id) => blockedAncestorIds.has(id));
    failedIds.push(...blockedIds);

    const eligibleIds = ids.filter((id) => !blockedAncestorIds.has(id));
    if (eligibleIds.length === 0) continue;

    const result = await args.archiveSessions(eligibleIds, options);
    archivedIds.push(...result.archivedIds);
    failedIds.push(...result.failedIds);
    for (const failedId of result.failedIds) blockAncestors(failedId);
  }

  return { archivedIds, failedIds, targetCount };
};
