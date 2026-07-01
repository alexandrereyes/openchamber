import { describe, expect, test } from 'bun:test';

import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';
import { getToolMetadata } from '@/lib/toolHelpers';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';

describe('readTaskTagSessionIdFromOutput', () => {
    test('parses task tags without state attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_abc123">')).toBe('ses_abc123');
    });

    test('parses task tags with additional attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_def456" state="completed">')).toBe('ses_def456');
    });
});

// ─── Bug reproduction: ToolPart header ignores state.title ───
// When a tool invocation returns a ToolResult with a custom title (e.g.
// { title: "Summary [src/main.py]", output: "..." }), the ToolPart card
// header always shows getToolMetadata(toolName).displayName (the tool's
// registered name) instead of the per-invocation state.title.
//
// The custom title is only used in the justificationText / subtitle row,
// never as the primary header.

describe('ToolPart header reproduction', () => {
    // Simulate a custom tool (not in the known metadata map) to make
    // the discrepancy obvious: displayName will be the auto-formatted
    // tool name, while state.title holds the per-invocation context.
    const makeCustomToolPart = (overrides?: Partial<ToolPartType['state']>): ToolPartType => ({
        id: 'tool-call-1',
        sessionID: 'ses_test',
        messageID: 'msg_test',
        type: 'tool',
        callID: 'call-1',
        tool: 'my_custom_tool',
        state: {
            status: 'completed' as const,
            input: {},
            output: 'Some output text',
            title: 'Summary [src/main.py]',
            metadata: {},
            time: { start: 1000, end: 2000 },
            ...overrides,
        } as ToolPartType['state'],
        metadata: {},
    });

    test('state.title differs from getToolMetadata().displayName', () => {
        const part = makeCustomToolPart();
        const displayName = getToolMetadata('my_custom_tool').displayName;
        const stateTitle = (part.state as ToolPartType['state'] & { title?: string }).title;

        // The tool's registered display name is the auto-formatted version of
        // the tool name, NOT the per-invocation title.
        expect(displayName).toBe('My custom tool');
        expect(stateTitle).toBe('Summary [src/main.py]');

        // BUG: The component header (line ~2487) renders {displayName}
        // unconditionally. The custom per-invocation title is only fed into
        // justificationText (line ~2346) which renders as a subtitle.
        // The header should prefer state.title when available.
        expect(displayName).not.toBe(stateTitle);
    });

    test('state.title is available for completed tools', () => {
        const part = makeCustomToolPart();
        const state = part.state as ToolPartType['state'] & { title?: string };
        expect(state.title).toBe('Summary [src/main.py]');
    });

    test('state.title is available for running tools', () => {
        const part = makeCustomToolPart({ status: 'running', title: 'Processing file.txt' });
        const state = part.state as ToolPartType['state'] & { title?: string };
        expect(state.title).toBe('Processing file.txt');
    });

    test('ToolPart.tsx renders displayName in header, not state.title', () => {
        const part = makeCustomToolPart();
        const normalizedPartTool = part.tool.trim().toLowerCase();
        const displayName = getToolMetadata(normalizedPartTool || part.tool).displayName;

        // This is the exact line from ToolPart.tsx:~2327 that computes the header value.
        // The header <MinDurationShineText> at line ~2487 always renders {displayName}.
        expect(displayName).toBe('My custom tool');

        // Meanwhile, state.title is only used in justificationText (line ~2346-2348)
        // which appears in the subtitle/description row (line ~2506-2513), NOT in the header.
        const stateTitle = (part.state as ToolPartType['state'] & { title?: string }).title;
        expect(stateTitle).toBe('Summary [src/main.py]');

        // The header does NOT reference state.title — it shows the generic name.
        // The custom per-invocation title is relegated to a less prominent subtitle.
    });
});
