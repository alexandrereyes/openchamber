import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';

import {
  type ArchiveSessionsResult,
  archiveMobileSessionSubtree,
  collectMobileArchiveTargetIds,
} from './mobileSessionArchive';

const session = (id: string, parentID?: string, archivedAt?: number): Session => ({
  id,
  parentID,
  time: archivedAt ? { archived: archivedAt } : {},
}) as Session;

const RUNTIME_KEY = 'runtime:a';

/** Records every batch it receives and archives everything except `failing`. */
const createArchiveSpy = (failing: string[] = []) => {
  const calls: Array<{ ids: string[]; options?: Record<string, unknown> }> = [];
  const archiveSessions = async (
    ids: string[],
    options?: Record<string, unknown>,
  ): Promise<ArchiveSessionsResult> => {
    calls.push({ ids, options });
    return {
      archivedIds: ids.filter((id) => !failing.includes(id)),
      failedIds: ids.filter((id) => failing.includes(id)),
    };
  };
  return { calls, archiveSessions };
};

describe('mobile session archive targets', () => {
  test('archives only the row when it has no subsessions', () => {
    const sessions = [session('ses_root'), session('ses_other')];

    expect(collectMobileArchiveTargetIds(sessions, 'ses_root')).toEqual(['ses_root']);
  });

  test('archives the whole subtree at any depth, root first', () => {
    const sessions = [
      session('ses_root'),
      session('ses_child_a', 'ses_root'),
      session('ses_child_b', 'ses_root'),
      session('ses_grandchild', 'ses_child_a'),
      session('ses_unrelated'),
      session('ses_unrelated_child', 'ses_unrelated'),
    ];

    const targets = collectMobileArchiveTargetIds(sessions, 'ses_root');

    expect(targets[0]).toBe('ses_root');
    expect([...targets].sort()).toEqual([
      'ses_child_a',
      'ses_child_b',
      'ses_grandchild',
      'ses_root',
    ]);
  });

  test('skips descendants that are already archived', () => {
    const sessions = [
      session('ses_root'),
      session('ses_active_child', 'ses_root'),
      session('ses_archived_child', 'ses_root', 1),
    ];

    expect(collectMobileArchiveTargetIds(sessions, 'ses_root')).toEqual([
      'ses_root',
      'ses_active_child',
    ]);
  });

  test('reaches an active session below an archived intermediate', () => {
    const sessions = [
      session('ses_root'),
      session('ses_archived_middle', 'ses_root', 1),
      session('ses_active_leaf', 'ses_archived_middle'),
    ];

    expect(collectMobileArchiveTargetIds(sessions, 'ses_root')).toEqual([
      'ses_root',
      'ses_active_leaf',
    ]);
  });

  test('keeps the swiped row even when it is not in the list', () => {
    expect(collectMobileArchiveTargetIds([session('ses_other')], 'ses_root')).toEqual(['ses_root']);
  });

  test('terminates on a corrupted parent cycle without duplicating IDs', () => {
    const sessions = [
      session('ses_root'),
      session('ses_a', 'ses_root'),
      session('ses_b', 'ses_a'),
      session('ses_root', 'ses_b'),
    ];

    const targets = collectMobileArchiveTargetIds(sessions, 'ses_root');

    expect(targets).toEqual(['ses_root', 'ses_a', 'ses_b']);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('mobile session archive subtree', () => {
  test('pins a childless row to the runtime it was swiped on', async () => {
    const spy = createArchiveSpy();

    const result = await archiveMobileSessionSubtree({
      sessions: [session('ses_root')],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
    });

    expect(spy.calls).toEqual([{ ids: ['ses_root'], options: { expectedRuntimeKey: RUNTIME_KEY } }]);
    expect(result).toEqual({ archivedIds: ['ses_root'], failedIds: [], targetCount: 1 });
  });

  test('archives descendants before their ancestors, root last', async () => {
    const spy = createArchiveSpy();

    const result = await archiveMobileSessionSubtree({
      sessions: [
        session('ses_root'),
        session('ses_child', 'ses_root'),
        session('ses_grandchild', 'ses_child'),
      ],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
    });

    expect(spy.calls.map((call) => call.ids)).toEqual([
      ['ses_grandchild', 'ses_child'],
      ['ses_root'],
    ]);
    expect(spy.calls.every((call) => call.options?.expectedRuntimeKey === RUNTIME_KEY)).toBe(true);
    expect(result.archivedIds).toEqual(['ses_grandchild', 'ses_child', 'ses_root']);
    expect(result.failedIds).toEqual([]);
    expect(result.targetCount).toBe(3);
  });

  test('leaves the parent active when a descendant fails', async () => {
    const spy = createArchiveSpy(['ses_child']);

    const result = await archiveMobileSessionSubtree({
      sessions: [session('ses_root'), session('ses_child', 'ses_root')],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
    });

    expect(spy.calls.map((call) => call.ids)).toEqual([['ses_child']]);
    expect(result.archivedIds).toEqual([]);
    expect(result.failedIds).toEqual(['ses_child', 'ses_root']);
  });

  test('collects a descendant through an archived intermediate before the root', async () => {
    const spy = createArchiveSpy();

    await archiveMobileSessionSubtree({
      sessions: [
        session('ses_root'),
        session('ses_archived_middle', 'ses_root', 1),
        session('ses_active_leaf', 'ses_archived_middle'),
      ],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
    });

    expect(spy.calls.map((call) => call.ids)).toEqual([['ses_active_leaf'], ['ses_root']]);
  });
});
