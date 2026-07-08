import { describe, expect, test } from 'bun:test';

/**
 * Reproduces the bug described in issue #2088.
 *
 * The baseDisplayMessages memo in MessageList.tsx (lines 1341–1387) performs
 * message deduplication from tail-to-head (newest to oldest). During history
 * pagination (prepend mode), the server may return messages that overlap with
 * the current view at the boundary. The tail-to-head iteration keeps the NEWER
 * occurrence (from the existing view) and discards the OLDER one (from the
 * prepended history).
 *
 * This test demonstrates that:
 *  - Tail-to-head dedup keeps the existing (newer-in-array) reference
 *  - Head-to-tail dedup keeps the prepended (older-in-array) reference
 *  - The head-to-tail direction is correct for chronological ordering
 *    because older messages appear first in the array
 */

type ChatMessageEntry = {
  info?: { id?: string };
  parts: { type: string }[];
};

// Helper to track which messages were kept
type Tracker = { id: string; source: string };

// ORIGINAL: tail-to-head dedup (keeps newer occurrence, reverses)
function dedupTailToHead(messages: ChatMessageEntry[]): { result: ChatMessageEntry[]; kept: Tracker[] } {
  const seenIdsFromTail = new Set<string>();
  const dedupedMessages: ChatMessageEntry[] = [];
  const kept: Tracker[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageId = message.info?.id;
    if (typeof messageId === 'string') {
      if (seenIdsFromTail.has(messageId)) {
        continue;
      }
      seenIdsFromTail.add(messageId);
    }
    dedupedMessages.push(message);
    kept.push({
      id: messageId ?? '(no id)',
      source: (message as { _source?: string })._source ?? `index_${index}`,
    });
  }
  dedupedMessages.reverse();
  kept.reverse();
  return { result: dedupedMessages, kept };
}

// FIXED: head-to-tail dedup (keeps older occurrence, no reverse needed)
function dedupHeadToTail(messages: ChatMessageEntry[]): { result: ChatMessageEntry[]; kept: Tracker[] } {
  const seenIds = new Set<string>();
  const dedupedMessages: ChatMessageEntry[] = [];
  const kept: Tracker[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const messageId = message.info?.id;
    if (typeof messageId === 'string') {
      if (seenIds.has(messageId)) {
        continue;
      }
      seenIds.add(messageId);
    }
    dedupedMessages.push(message);
    kept.push({
      id: messageId ?? '(no id)',
      source: (message as { _source?: string })._source ?? `index_${index}`,
    });
  }
  return { result: dedupedMessages, kept };
}

const ids = (msgs: ChatMessageEntry[]): string[] => msgs.map((m) => m.info?.id ?? '(no id)');

/**
 * Pagination scenario:
 *
 * Initial view (newest messages at the bottom):
 *   [msg_002_user, msg_003_assistant, msg_004_user, msg_005_assistant]
 *   ↑ oldest                               newest ↑
 *
 * User scrolls up, triggers history pagination. Server returns older messages
 * including the boundary message:
 *   [msg_000_user, msg_001_assistant, msg_002_user]
 *   (msg_002_user is the boundary overlap with current view)
 *
 * After merge (chronological order, oldest first):
 *   [msg_000, msg_001, msg_002_overlap_1 (prepended), msg_002_overlap_2 (existing), msg_003, msg_004, msg_005]
 *
 * NOTE: The store normally deduplicates via mergeMessages(), so this scenario
 * only manifests if there's a code path that doesn't deduplicate before
 * passing messages to MessageList. The defensive dedup in MessageList.tsx
 * should handle this correctly regardless.
 */

describe('Base display messages dedup order (#2088)', () => {
  test('tail-to-head keeps NEWER occurrence (existing view)', () => {
    const msg000 = { info: { id: 'msg_000' }, parts: [{ type: 'text' }], _source: 'prepended' } as ChatMessageEntry & { _source: string };
    const msg001 = { info: { id: 'msg_001' }, parts: [{ type: 'text' }], _source: 'prepended' } as ChatMessageEntry & { _source: string };
    const msg002_prepended = { info: { id: 'msg_002' }, parts: [{ type: 'text' }], _source: 'prepended' } as ChatMessageEntry & { _source: string };
    const msg002_existing = { info: { id: 'msg_002' }, parts: [{ type: 'text' }], _source: 'existing' } as ChatMessageEntry & { _source: string };
    const msg003 = { info: { id: 'msg_003' }, parts: [{ type: 'text' }], _source: 'existing' } as ChatMessageEntry & { _source: string };
    const msg004 = { info: { id: 'msg_004' }, parts: [{ type: 'text' }], _source: 'existing' } as ChatMessageEntry & { _source: string };
    const msg005 = { info: { id: 'msg_005' }, parts: [{ type: 'text' }], _source: 'existing' } as ChatMessageEntry & { _source: string };

    // Merged array with boundary overlap: msg_002 appears twice
    const merged: ChatMessageEntry[] = [
      msg000,
      msg001,
      msg002_prepended,
      msg002_existing,
      msg003,
      msg004,
      msg005,
    ];

    const { result, kept } = dedupTailToHead(merged);

    expect(ids(result)).toEqual(['msg_000', 'msg_001', 'msg_002', 'msg_003', 'msg_004', 'msg_005']);
    // The boundary message (msg_002) is kept from the EXISTING view — the NEWER occurrence
    expect(kept.find((t) => t.id === 'msg_002')?.source).toBe('existing');
    expect(result[2]).toBe(msg002_existing);
  });

  test('head-to-tail keeps OLDER occurrence (prepended history)', () => {
    const msg000 = { info: { id: 'msg_000' }, parts: [{ type: 'text' }], _source: 'prepended' } as ChatMessageEntry & { _source: string };
    const msg001 = { info: { id: 'msg_001' }, parts: [{ type: 'text' }], _source: 'prepended' } as ChatMessageEntry & { _source: string };
    const msg002_prepended = { info: { id: 'msg_002' }, parts: [{ type: 'text' }], _source: 'prepended' } as ChatMessageEntry & { _source: string };
    const msg002_existing = { info: { id: 'msg_002' }, parts: [{ type: 'text' }], _source: 'existing' } as ChatMessageEntry & { _source: string };
    const msg003 = { info: { id: 'msg_003' }, parts: [{ type: 'text' }], _source: 'existing' } as ChatMessageEntry & { _source: string };

    const merged: ChatMessageEntry[] = [
      msg000,
      msg001,
      msg002_prepended,
      msg002_existing,
      msg003,
    ];

    const { result, kept } = dedupHeadToTail(merged);

    expect(ids(result)).toEqual(['msg_000', 'msg_001', 'msg_002', 'msg_003']);
    // The boundary message (msg_002) is kept from the PREPENDED history — the OLDER occurrence
    expect(kept.find((t) => t.id === 'msg_002')?.source).toBe('prepended');
    expect(result[2]).toBe(msg002_prepended);
  });

  test('both approaches produce same ID ordering for deduplicated input', () => {
    const msgs: ChatMessageEntry[] = [
      { info: { id: 'msg_000' }, parts: [{ type: 'text' }] },
      { info: { id: 'msg_001' }, parts: [{ type: 'text' }] },
      { info: { id: 'msg_002' }, parts: [{ type: 'text' }] },
      { info: { id: 'msg_003' }, parts: [{ type: 'text' }] },
    ];

    const tailResult = dedupTailToHead(msgs).result;
    const headResult = dedupHeadToTail(msgs).result;

    expect(ids(tailResult)).toEqual(ids(headResult));
    expect(tailResult).toHaveLength(4);
    expect(headResult).toHaveLength(4);
  });

  test('tail-to-head preserves stale boundary message over fresh server data', () => {
    // Simulate a scenario where the existing view has stale data for the
    // boundary message (e.g., parts were finalized server-side but the
    // store hasn't been updated yet). The prepended version from the
    // server has definitive content.
    const msg002_prepended_fresh = {
      info: { id: 'msg_002' },
      parts: [{ type: 'text' }],
      _source: 'prepended_fresh',
    } as ChatMessageEntry & { _source: string };

    // The existing boundary message might have stale compaction/summary parts
    const msg002_existing_stale = {
      info: { id: 'msg_002' },
      parts: [{ type: 'compaction' }],
      _source: 'existing_stale',
    } as ChatMessageEntry & { _source: string };

    const msg001 = { info: { id: 'msg_001' }, parts: [{ type: 'text' }], _source: 'prepended' } as ChatMessageEntry & { _source: string };
    const msg003 = { info: { id: 'msg_003' }, parts: [{ type: 'text' }], _source: 'existing' } as ChatMessageEntry & { _source: string };

    const merged: ChatMessageEntry[] = [
      msg001,
      msg002_prepended_fresh,
      msg002_existing_stale,
      msg003,
    ];

    const { result: tailResult, kept: tailKept } = dedupTailToHead(merged);
    const { result: headResult, kept: headKept } = dedupHeadToTail(merged);

    // Tail-to-head keeps the stale existing message
    expect(tailKept.find((t) => t.id === 'msg_002')?.source).toBe('existing_stale');
    // Head-to-tail keeps the fresh prepended message
    expect(headKept.find((t) => t.id === 'msg_002')?.source).toBe('prepended_fresh');
  });
});
