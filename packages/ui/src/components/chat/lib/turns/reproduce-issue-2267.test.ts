/**
 * Reproduction test for issue #2267:
 * Long sessions mount entire message/tool history, causing severe input lag.
 *
 * This test demonstrates three contributing factors:
 *
 * 1. The `useTurnRecords` hook always treats the LAST turn as the "streaming"
 *    turn, even when the session is fully loaded (not streaming). This means
 *    the last turn is always rendered outside the virtualizer via
 *    `StreamingTailContent`, with ALL its messages and tool call DOM nodes
 *    unconditionally mounted.
 *
 * 2. The `MESSAGE_LIST_VIRTUALIZE_THRESHOLD = 5` means sessions with ≤4
 *    static entries (all turns minus the last) use the 'none' engine —
 *    i.e., ALL entries are rendered without any virtualization. A tool-heavy
 *    session with 4 turns (1 user + assistant each) produces only 3 static
 *    entries, falling below the threshold.
 *
 * 3. Even when the virtualizer IS enabled, the overscan of 8 items above and
 *    below the visible range means sessions with ≤20 static turns mount ALL
 *    turns in the DOM. Each turn's messages and tool call DOM nodes are nested
 *    children, so when ALL turns are mounted, ALL messages and tool calls are
 *    in the DOM.
 */
import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

const MESSAGE_LIST_VIRTUALIZE_THRESHOLD = 5;
const TANSTACK_OVERSCAN = 8;

/**
 * Create a minimal message entry for testing.
 */
function createMessageEntry({
    id,
    role,
    parentID,
    createdAt,
    parts,
}: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    parentID?: string;
    createdAt: number;
    parts?: Part[];
}): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            ...(parentID ? { parentID } : {}),
            time: { created: createdAt },
        } as Message,
        parts: parts ?? [],
    };
}

/**
 * Create a tool part to simulate tool-heavy sessions.
 */
function createToolPart(toolName: string, status: string): Part {
    return {
        type: 'tool',
        id: `tool_${Math.random().toString(36).slice(2, 8)}`,
        sessionID: 'session_1',
        messageID: 'msg_1',
        callID: `call_${Math.random().toString(36).slice(2, 8)}`,
        tool: toolName,
        state: { status, input: '{}', output: '' },
        input: '{}',
        output: '',
    } as unknown as Part;
}

describe('Issue #2267: Chat virtualization is bypassed for tool-heavy sessions', () => {
    test('1. StreamingTurn is always the last turn (even when fully loaded)', () => {
        // Create a session with 5 turns, each with many tool calls.
        // The last turn is NOT actively streaming — it's a completed session.
        const messages: ChatMessageEntry[] = [];
        for (let turnIdx = 0; turnIdx < 5; turnIdx++) {
            const userId = `user_${turnIdx}`;
            const assistantId = `assistant_${turnIdx}`;
            messages.push(
                createMessageEntry({
                    id: userId,
                    role: 'user',
                    createdAt: turnIdx * 10,
                }),
                createMessageEntry({
                    id: assistantId,
                    role: 'assistant',
                    parentID: userId,
                    createdAt: turnIdx * 10 + 1,
                    parts: [
                        createToolPart('bash', 'completed'),
                        createToolPart('edit', 'completed'),
                        createToolPart('read', 'completed'),
                    ],
                }),
            );
        }

        const projection = projectTurnRecords(messages);

        // There should be 5 turns (one per user message)
        expect(projection.turns).toHaveLength(5);

        // `useTurnRecords` does:
        //   staticTurns = projection.turns.slice(0, -1)  → first 4 turns
        //   streamingTurn = projection.turns[length - 1]  → 5th turn (always treated as streaming)
        const staticTurns = projection.turns.length <= 1
            ? []
            : projection.turns.slice(0, -1);
        const streamingTurn = projection.turns.length === 0
            ? undefined
            : projection.turns[projection.turns.length - 1];

        // The last turn is ALWAYS designated as "streaming" even though it's completed
        expect(staticTurns).toHaveLength(4);
        expect(streamingTurn).toBeDefined();
        expect(streamingTurn?.turnId).toBe('user_4');

        // Verify the streaming turn has all its original tool calls
        expect(streamingTurn?.assistantMessages).toHaveLength(1);
        expect(streamingTurn?.assistantMessages[0]?.parts).toHaveLength(3);

        // This last turn is rendered by `StreamingTailContent` OUTSIDE the virtualizer,
        // meaning ALL its DOM nodes are always mounted.
        // In `MessageList.tsx`:
        //   {trailingStreamingEntry ? (
        //       <StreamingTailContent ... />
        //   ) : null}
        // `trailingStreamingEntry` is set whenever streamingTurn is truthy,
        // which is ALWAYS for the last turn of any session with turns.
    });

    test('2. Sessions with <5 static entries bypass virtualization entirely', () => {
        // Create a tool-heavy session with only 3 turns.
        // staticTurns = 3 - 1 = 2 entries, which is < 5 threshold
        const messages: ChatMessageEntry[] = [];
        for (let turnIdx = 0; turnIdx < 3; turnIdx++) {
            const userId = `user_${turnIdx}`;
            const assistantId = `assistant_${turnIdx}`;
            messages.push(
                createMessageEntry({
                    id: userId,
                    role: 'user',
                    createdAt: turnIdx * 10,
                }),
                createMessageEntry({
                    id: assistantId,
                    role: 'assistant',
                    parentID: userId,
                    createdAt: turnIdx * 10 + 1,
                    parts: Array.from({ length: 50 }, (_, i) =>
                        createToolPart(i % 2 === 0 ? 'bash' : 'edit', 'completed'),
                    ),
                }),
            );
        }

        const projection = projectTurnRecords(messages);
        expect(projection.turns).toHaveLength(3);

        // This session has only 3 turns → useTurnRecords gives:
        const staticTurns = projection.turns.length <= 1
            ? []
            : projection.turns.slice(0, -1);

        // staticTurns = first 2 turns = 2 entries
        // historyEntries.length = 2
        // shouldVirtualizeHistory = 2 >= 5 → FALSE
        // historyEngine = 'none' → NO VIRTUALIZATION
        //
        // Meanwhile, streamingTurn = last turn (3rd turn) → rendered in StreamingTailContent

        const shouldVirtualize = staticTurns.length >= MESSAGE_LIST_VIRTUALIZE_THRESHOLD;
        expect(staticTurns).toHaveLength(2);
        expect(shouldVirtualize).toBe(false);

        // RESULT: ALL 3 turns are fully rendered:
        //   - 2 static turns rendered non-virtualized in StaticHistoryList (engine='none')
        //   - 1 streaming turn rendered in StreamingTailContent (always full)
        // Total: 3 turns with 50 tool calls each = 150 tool DOM nodes + 6 message nodes
        // All permanently mounted, no virtualization.
    });

    test('3. Even with virtualizer enabled, overscan mounts all turns for ≤20-item sessions', () => {
        // Simulate 15 turns — this is above the virtualization threshold of 5,
        // so the tanstack virtualizer IS enabled.
        // However, overscan of 8 + visible ≈ 4 = up to 20 items mounted.
        // With only 15 items, ALL fit in the overscan window.
        const messages: ChatMessageEntry[] = [];
        for (let turnIdx = 0; turnIdx < 15; turnIdx++) {
            const userId = `user_${turnIdx}`;
            const assistantId = `assistant_${turnIdx}`;
            messages.push(
                createMessageEntry({
                    id: userId,
                    role: 'user',
                    createdAt: turnIdx * 10,
                }),
                createMessageEntry({
                    id: assistantId,
                    role: 'assistant',
                    parentID: userId,
                    createdAt: turnIdx * 10 + 1,
                    parts: Array.from({ length: 20 }, (_, i) =>
                        createToolPart(i % 3 === 0 ? 'bash' : i % 3 === 1 ? 'edit' : 'read', 'completed'),
                    ),
                }),
            );
        }

        const projection = projectTurnRecords(messages);
        expect(projection.turns).toHaveLength(15);

        const staticTurns = projection.turns.length <= 1
            ? []
            : projection.turns.slice(0, -1);
        const streamingTurn = projection.turns.length === 0
            ? undefined
            : projection.turns[projection.turns.length - 1];

        // Virtualizer is enabled (14 static entries >= 5 threshold)
        const shouldVirtualize = staticTurns.length >= MESSAGE_LIST_VIRTUALIZE_THRESHOLD;
        expect(shouldVirtualize).toBe(true);

        // With 14 static entries and overscan of 8 + visible ≈ 4:
        //   virtualizer range = [0, 14) = ALL 14 entries within visible + overscan window
        //   → ALL 14 static entries are mounted
        //   + 1 streaming turn in tail = 15/15 turns mounted
        //
        // Total DOM: 15 turns × ~1 user + 1 assistant messages × 20 tool parts each
        // = 30 message components + 300 tool call rows, ALL permanently mounted

        const totalPotentialMounted = staticTurns.length + (streamingTurn ? 1 : 0);
        expect(totalPotentialMounted).toBe(15);

        // With viewport ~1160px and estimate ~320px per entry:
        //   visible ≈ 3-4 entries
        //   mounted by virtualizer ≈ 3 + 8 + 8 = 19 entries (capped at total)
        //   So all 14 static entries + 1 streaming = all 15 turns mounted
        //   NONE are virtualized out of the DOM
        const visibleRange = 4; // ~1160 / 320
        const mountedByVirtualizer = Math.min(staticTurns.length, visibleRange + TANSTACK_OVERSCAN + TANSTACK_OVERSCAN);
        expect(mountedByVirtualizer).toBe(14); // ALL static entries
    });

    test('4. Combined: single-turn sessions with many tool calls render everything', () => {
        // A session with a single turn: 1 user message + 1 assistant with 500 tool calls
        const messages: ChatMessageEntry[] = [
            createMessageEntry({
                id: 'user_0',
                role: 'user',
                createdAt: 0,
            }),
            createMessageEntry({
                id: 'assistant_0',
                role: 'assistant',
                parentID: 'user_0',
                createdAt: 1,
                parts: Array.from({ length: 500 }, (_, i) =>
                    createToolPart(i % 5 === 0 ? 'bash' : i % 5 === 1 ? 'edit' : i % 5 === 2 ? 'read' : i % 5 === 3 ? 'grep' : 'glob', 'completed'),
                ),
            }),
        ];

        const projection = projectTurnRecords(messages);
        expect(projection.turns).toHaveLength(1);

        // useTurnRecords:
        const staticTurns = projection.turns.length <= 1 ? [] : projection.turns.slice(0, -1);
        const streamingTurn = projection.turns.length === 0 ? undefined : projection.turns[0];

        // staticTurns = [], so historyEntries = [], shouldVirtualizeHistory = false
        expect(staticTurns).toHaveLength(0);
        expect(staticTurns.length >= MESSAGE_LIST_VIRTUALIZE_THRESHOLD).toBe(false);

        // streamingTurn = the single turn with 500 tool calls
        expect(streamingTurn).toBeDefined();
        expect(streamingTurn?.assistantMessages).toHaveLength(1);
        expect(streamingTurn?.assistantMessages[0]?.parts).toHaveLength(500);

        // RESULT:
        // - No static history (empty)
        // - Streaming tail renders the single turn with ALL 500 tool calls
        // - ALL DOM nodes are permanently mounted
        // - No virtualization at all
    });
});
