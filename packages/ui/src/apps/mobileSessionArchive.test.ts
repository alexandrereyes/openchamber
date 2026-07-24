import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';

import { collectActiveSessionSubtreeIds } from '@/apps/mobileSessionArchive';

const session = (
  id: string,
  parentID?: string,
  options?: { archived?: boolean; directory?: string },
): Session => ({
  id,
  parentID,
  directory: options?.directory,
  time: {
    created: 1,
    ...(options?.archived ? { archived: 2 } : {}),
  },
}) as Session;

describe('mobile session archive subtree', () => {
  test('collects descendants across sibling branches at every depth', () => {
    expect(collectActiveSessionSubtreeIds([
      session('root'),
      session('child-a', 'root'),
      session('child-b', 'root'),
      session('grandchild', 'child-a'),
      session('great-grandchild', 'grandchild'),
      session('unrelated-root'),
      session('unrelated-child', 'unrelated-root'),
    ], 'root')).toEqual(['root', 'child-a', 'child-b', 'grandchild', 'great-grandchild']);
  });

  test('returns only an active root that has no children', () => {
    expect(collectActiveSessionSubtreeIds([
      session('root'),
      session('other-root'),
    ], 'root')).toEqual(['root']);
  });

  test('collects known descendants outside the root directory and visual bucket', () => {
    expect(collectActiveSessionSubtreeIds([
      session('root', undefined, { directory: '/project' }),
      session('other-bucket-child', 'root', { directory: '/project/worktree' }),
      session('other-directory-grandchild', 'other-bucket-child', { directory: '/other-project' }),
    ], 'root')).toEqual(['root', 'other-bucket-child', 'other-directory-grandchild']);
  });

  test('deduplicates repeated session records', () => {
    const child = session('child', 'root');
    expect(collectActiveSessionSubtreeIds([
      session('root'),
      child,
      child,
      session('grandchild', 'child'),
    ], 'root')).toEqual(['root', 'child', 'grandchild']);
  });

  test('terminates corrupted cycles without duplicating sessions', () => {
    expect(collectActiveSessionSubtreeIds([
      session('root', 'grandchild'),
      session('child', 'root'),
      session('grandchild', 'child'),
    ], 'root')).toEqual(['root', 'child', 'grandchild']);
  });

  test('skips archived sessions while still traversing to active descendants', () => {
    expect(collectActiveSessionSubtreeIds([
      session('root'),
      session('archived-child', 'root', { archived: true }),
      session('active-grandchild', 'archived-child'),
    ], 'root')).toEqual(['root', 'active-grandchild']);
  });
});
