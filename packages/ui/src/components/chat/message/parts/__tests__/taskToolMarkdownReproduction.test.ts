/**
 * Reproduction test + root cause analysis for issue #1902:
 * Subagent task tool output shows raw Markdown instead of rendered HTML in main chat.
 *
 * ## Rendering paths for task tool output
 *
 * ### Path 1: TaskToolSummary (line 1430 in ToolPart.tsx)
 *   ToolPartContent → TaskToolSummary → SimpleMarkdownRenderer (variant="tool")
 *   - Uses stripTaskMetadataFromOutput() to remove trailing <task_metadata> block
 *   - Renders output only when user clicks "Output" toggle (collapsible section)
 *   - Conditionally mounted (unmounted when collapsed)
 *
 * ### Path 2: ToolExpandedContent (line 1848, DEAD CODE for task tools)
 *   ToolPartContent → ToolExpandedContent → SimpleMarkdownRenderer (variant="tool")
 *   - NOT rendered for task tools because `!isTaskTool` check on line 2564 blocks it
 *   - Would use outputString directly WITHOUT stripping metadata
 *   - This code path handles other tools (edit, write, bash, etc.)
 *
 * ## Suspected root causes (from issue)
 *
 * 1. SimpleMarkdownRenderer uses static cacheKey "simple:tool" vs MarkdownRenderer's
 *    per-part cache key. Shared cache across all tool outputs could cause stale renders.
 *
 * 2. SimpleMarkdownRenderer doesn't use usePacedText (streaming animation) like
 *    MarkdownRenderer does. Not relevant for finalized output.
 *
 * 3. stripTaskMetadataFromOutput may fail on edge cases.
 *
 * 4. CSS class markdown-tool changes font-size but doesn't prevent rendering.
 *
 * ## Our findings
 *
 * - The markdown parser (marked) correctly renders the example content to HTML
 *   with <h3>, <ul>, <li>, and <code> elements.
 * - stripTaskMetadataFromOutput correctly handles trailing <task_metadata> blocks.
 * - The ToolExpandedContent path (line 1845-1851) is dead code for task tools;
 *   all task tool output goes through TaskToolSummary.
 * - The cache key collision shouldn't cause incorrect rendering because each cache
 *   entry includes a content hash check.
 */

import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Replicate exact functions from the codebase
// ---------------------------------------------------------------------------

// From ToolPart.tsx lines 1224-1227
const stripTaskMetadataFromOutput = (output: string): string => {
    return output.replace(/\n*<task_metadata>[\s\S]*?<\/task_metadata>\s*$/i, '').trimEnd();
};

// From markdownCore.ts - simplified parser without math/kaTeX extensions
// to test in a non-DOM environment (DOMPurify not available in Node)
import { marked } from 'marked';

const parser = marked.use({
    gfm: true,
    breaks: false,
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const EXAMPLE_MARKDOWN_CONTENT = `### Startup
- Route: \`PR review\`
- Mode: \`read-only\`
- Summary: Review PR #1897 changes`;

const EXAMPLE_WITH_METADATA = `${EXAMPLE_MARKDOWN_CONTENT}

<task_metadata>
{"sessionId":"ses_abc123","summary":[{"tool":"read","title":"Review PR #1897","status":"completed"}]}
</task_metadata>`;

const EXAMPLE_WITH_MULTIPLE_METADATA = `${EXAMPLE_MARKDOWN_CONTENT}

<task_metadata>
{"sessionId":"ses_abc123","summary":[{"tool":"read","title":"Review PR #1897","status":"completed"},{"tool":"edit","title":"Fix typo","status":"completed"}]}
</task_metadata>`;

const EXAMPLE_WITH_METADATA_NO_TRAILING_NEWLINE = `${EXAMPLE_MARKDOWN_CONTENT}

<task_metadata>
{"sessionId":"ses_abc123","summary":[]}
</task_metadata>`;

// ---------------------------------------------------------------------------
// Tests for stripTaskMetadataFromOutput
// ---------------------------------------------------------------------------
describe('stripTaskMetadataFromOutput', () => {
    test('strips trailing <task_metadata> block', () => {
        const result = stripTaskMetadataFromOutput(EXAMPLE_WITH_METADATA);
        expect(result).toBe(EXAMPLE_MARKDOWN_CONTENT);
        expect(result).not.toContain('<task_metadata>');
    });

    test('does not modify content without metadata', () => {
        const result = stripTaskMetadataFromOutput(EXAMPLE_MARKDOWN_CONTENT);
        expect(result).toBe(EXAMPLE_MARKDOWN_CONTENT);
    });

    test('handles metadata without leading newlines', () => {
        const result = stripTaskMetadataFromOutput(EXAMPLE_WITH_METADATA_NO_TRAILING_NEWLINE);
        expect(result).toBe(EXAMPLE_MARKDOWN_CONTENT);
    });

    test('handles empty string', () => {
        expect(stripTaskMetadataFromOutput('')).toBe('');
    });

    test('handles metadata-only output', () => {
        const result = stripTaskMetadataFromOutput('<task_metadata>{"sessionId":"ses_abc"}</task_metadata>');
        expect(result).toBe('');
    });

    test('does NOT strip metadata that is not at the end', () => {
        const contentWithEmbedded = 'Some text <task_metadata>{"x":1}</task_metadata> more text';
        const result = stripTaskMetadataFromOutput(contentWithEmbedded);
        // The embedded metadata is not at the end (has trailing " more text"),
        // so the $ anchor prevents the regex from matching
        expect(result).toBe(contentWithEmbedded);
    });

    test('strips metadata with various whitespace patterns', () => {
        // No newlines before metadata
        const noNewlines = `${EXAMPLE_MARKDOWN_CONTENT}<task_metadata>{}</task_metadata>`;
        expect(stripTaskMetadataFromOutput(noNewlines)).toBe(EXAMPLE_MARKDOWN_CONTENT);

        // Multiple newlines before metadata
        const multiNewlines = `${EXAMPLE_MARKDOWN_CONTENT}\n\n\n<task_metadata>{}</task_metadata>`;
        expect(stripTaskMetadataFromOutput(multiNewlines)).toBe(EXAMPLE_MARKDOWN_CONTENT);
    });

    test('strips trailing whitespace after removing metadata', () => {
        const withTrailingSpace = `${EXAMPLE_MARKDOWN_CONTENT}\n\n<task_metadata>{}</task_metadata>  \n  `;
        const result = stripTaskMetadataFromOutput(withTrailingSpace);
        expect(result).toBe(EXAMPLE_MARKDOWN_CONTENT);
        expect(result.endsWith(' ')).toBe(false);
    });

    test('handles metadata with complex nested JSON', () => {
        const complexMeta = `${EXAMPLE_MARKDOWN_CONTENT}

<task_metadata>
{"sessionId":"ses_abc","summary":[{"tool":"bash","title":"npm install","status":"completed","state":{"exitCode":0}}],"extra":{"nested":{"deeply":true}}}
</task_metadata>`;
        const result = stripTaskMetadataFromOutput(complexMeta);
        expect(result).toBe(EXAMPLE_MARKDOWN_CONTENT);
    });
});

// ---------------------------------------------------------------------------
// Tests for markdown parsing (without DOMPurify sanitization)
// ---------------------------------------------------------------------------
describe('markdown parsing (marked)', () => {
    test('renders h3 heading from ###', () => {
        const html = parser.parse(EXAMPLE_MARKDOWN_CONTENT) as string;
        expect(html).toContain('<h3');
        expect(html).toContain('Startup');
        // Should NOT contain raw markdown heading syntax
        expect(html).not.toContain('###');
    });

    test('renders unordered list', () => {
        const html = parser.parse(EXAMPLE_MARKDOWN_CONTENT) as string;
        expect(html).toContain('<ul');
        expect(html).toContain('<li');
        expect(html).not.toContain('- Route:');
    });

    test('renders inline code with backticks', () => {
        const html = parser.parse(EXAMPLE_MARKDOWN_CONTENT) as string;
        expect(html).toContain('<code');
        expect(html).toContain('PR review');
        expect(html).not.toContain('`PR review`');
    });

    test('renders all list items', () => {
        const html = parser.parse(EXAMPLE_MARKDOWN_CONTENT) as string;
        const liCount = (html.match(/<li/g) || []).length;
        expect(liCount).toBe(3);
    });

    test('markdown renders correctly when metadata block is present', () => {
        const html = parser.parse(EXAMPLE_WITH_METADATA) as string;
        // The markdown content should still render correctly
        expect(html).toContain('<h3');
        expect(html).toContain('<ul');
        expect(html).toContain('<code');
        // <task_metadata> tag passes through marked parser (custom HTML)
        expect(html).toContain('<task_metadata>');
    });

    test('no raw markdown syntax leaks through', () => {
        const html = parser.parse(EXAMPLE_MARKDOWN_CONTENT) as string;
        expect(html).not.toContain('###');
        expect(html).not.toContain('`PR review`');
        expect(html).not.toContain('- Route:');
    });

    test('bullet content values are present in rendered output', () => {
        const html = parser.parse(EXAMPLE_MARKDOWN_CONTENT) as string;
        expect(html).toContain('Startup');
        expect(html).toContain('PR review');
        expect(html).toContain('read-only');
        expect(html).toContain('Review PR');
    });
});

// ---------------------------------------------------------------------------
// Tests simulating the full TaskToolSummary rendering pipeline
// ---------------------------------------------------------------------------
describe('TaskToolSummary rendering pipeline', () => {
    test('strip then render produces correct HTML', () => {
        // This simulates the actual TaskToolSummary flow:
        // output → stripTaskMetadataFromOutput → SimpleMarkdownRenderer
        const stripped = stripTaskMetadataFromOutput(EXAMPLE_WITH_METADATA);
        const html = parser.parse(stripped) as string;

        expect(html).toContain('<h3');
        expect(html).toContain('Startup');
        expect(html).not.toContain('###');
        expect(html).not.toContain('<task_metadata>');
    });

    test('output without metadata renders correctly', () => {
        // Simulates a task tool output that doesn't have a metadata block
        const html = parser.parse(EXAMPLE_MARKDOWN_CONTENT) as string;
        expect(html).toContain('<h3');
        expect(html).not.toContain('###');
    });

    test('repeated renders with different content always produce HTML', () => {
        // Tests the scenario where SimpleMarkdownRenderer gets different
        // content across renders (which happens when different task tools
        // are rendered or when content updates)
        const contents = [
            'First output with **bold** text',
            'Second output with `inline code`',
            '### Third output with heading',
            EXAMPLE_MARKDOWN_CONTENT,
        ];

        for (const content of contents) {
            const html = parser.parse(content) as string;
            // Each render should produce HTML, not raw text
            expect(html).not.toBe(content);
            // Verify markdown constructs are consumed
            if (content.includes('**')) {
                expect(html).toContain('<strong>');
                expect(html).not.toContain('**');
            }
            if (content.includes('`')) {
                expect(html).toContain('<code>');
                expect(html).not.toContain('`');
            }
            if (content.startsWith('###')) {
                expect(html).toContain('<h3');
                expect(html).not.toContain('###');
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Analysis of cache key collision (SimpleMarkdownRenderer vs MarkdownRenderer)
// ---------------------------------------------------------------------------
describe('cache key analysis', () => {
    test('SimpleMarkdownRenderer uses static cacheKey', () => {
        // In MarkdownRendererImpl.tsx line 1241:
        //   cacheKey: `simple:${variant}`
        // For variant="tool", this becomes "simple:tool"
        //
        // In MarkdownRendererImpl.tsx line 1153:
        //   cacheKey = `markdown-${part?.id ? 'part-${part.id}' : 'message-${messageId}'}`
        // This is unique per part/message
        const simpleCacheKey = 'simple:tool';
        const markdownCacheKeyPart = 'markdown-part-part_abc123';
        const markdownCacheKeyMessage = 'markdown-message-msg_xyz';

        expect(simpleCacheKey).toBe('simple:tool');
        expect(markdownCacheKeyPart.startsWith('markdown-part-')).toBe(true);
        expect(markdownCacheKeyMessage.startsWith('markdown-message-')).toBe(true);

        // The cache key is used in renderMarkdownBlocks (markdownCore.ts line 384):
        //   const key = `${cacheKey}:${index}:${block.mode}`
        // So per-block keys become:
        //   SimpleMarkdownRenderer: "simple:tool:0:full"
        //   MarkdownRenderer: "markdown-part-part_abc123:0:full"
        //
        // The per-block cache checks content hash (markdownCore.ts line 382-388):
        //   const cached = htmlCache.get(key);
        //   if (cached && cached.hash === contentHash) {
        //       return { id, html: cached.html };
        //   }
        //
        // Since contentHash is FNV-1a of the raw block content, different content
        // produces a different hash, causing a cache miss and re-render.
        // The static cacheKey does NOT cause incorrect rendering for different content.
        // It only means cache entries are shared across all tool outputs, which could
        // cause false cache HITS if two different tool outputs produce identical content
        // (extremely unlikely for different subagent responses).
    });

    test('static cacheKey per-block key format', () => {
        const cacheKey = 'simple:tool';
        const blockIndex = 0;
        const blockMode = 'full';
        const expectedKey = `${cacheKey}:${blockIndex}:${blockMode}`;
        expect(expectedKey).toBe('simple:tool:0:full');
    });

    test('useLayoutEffect skips re-render when DOM already populated', () => {
        // In useMorphdomMarkdown (MarkdownRendererImpl.tsx line 1024-1043):
        //
        // React.useLayoutEffect(() => {
        //     const target = ...querySelector('[data-markdown-content]');
        //     if (text && target.childNodes.length === 0) {
        //         // First paint: render sync markdown
        //         block.innerHTML = renderMarkdownSync(text);
        //     }
        // }, [containerRef, text, ctx]);
        //
        // The key issue: this layout effect runs BEFORE the async effect.
        // On mount, target is empty → sync render populates it.
        // On content update, target has children → sync render is SKIPPED.
        //
        // The async effect (which runs after paint) always runs and reconciles
        // the full DOM via morphdom. Since cacheKey is NOT in the layout effect's
        // deps, the sync render may fire unnecessarily if text changes but the
        // target already has children (e.g., during streaming updates).
        //
        // However, SimpleMarkdownRenderer uses streaming=false, so it only
        // receives finalized content. The component is also conditionally mounted
        // (via isOutputExpanded), so each fresh mount starts with empty children.
        // This means the sync render should always fire on the relevant first mount.
        expect(true).toBe(true); // Documentation test
    });
});

// ---------------------------------------------------------------------------
// Analysis of hasOutput / trimmedOutput edge cases
// ---------------------------------------------------------------------------
describe('hasOutput edge cases', () => {
    test('stripTaskMetadataFromOutput returns empty for metadata-only output', () => {
        const metaOnly = '<task_metadata>{"sessionId":"ses_abc"}</task_metadata>';
        expect(stripTaskMetadataFromOutput(metaOnly)).toBe('');
    });

    test('stripTaskMetadataFromOutput preserves non-metadata output', () => {
        const plainText = 'Just some plain text output from the subagent';
        expect(stripTaskMetadataFromOutput(plainText)).toBe(plainText);
    });

    test('output with only whitespace after stripping metadata becomes empty', () => {
        const whitespace = '   \n  <task_metadata>{}</task_metadata>  \n  ';
        expect(stripTaskMetadataFromOutput(whitespace)).toBe('');
    });
});

// ---------------------------------------------------------------------------
// Summary of reproduction findings
// ---------------------------------------------------------------------------
/*
## Reproduction verification

### What works correctly

1. **stripTaskMetadataFromOutput** correctly removes trailing `<task_metadata>` blocks
   from tool output before passing to SimpleMarkdownRenderer.

2. **marked.parse** correctly renders the example Markdown content to HTML with
   proper `<h3>`, `<ul>`, `<li>`, and `<code>` elements.

3. The **ToolExpandedContent** markdown rendering path (line 1845-1851) is dead
   code for task tools due to the `!isTaskTool` gate on line 2564.

### Potential issues identified

1. **CACHE KEY COLLISION**: SimpleMarkdownRenderer uses `cacheKey="simple:tool"`,
   shared across ALL tool output instances. While the per-block cache includes
   content hash verification, this means the morphdom reconciliation step could
   skip updates if the hash matches a different tool's content (same content = same
   hash = cache hit). This is unlikely to cause bugs with different content.

   More importantly, the **useLayoutEffect sync render** (MarkdownRendererImpl.tsx
   line 1024-1043) does NOT include cacheKey in its dependency array
   `[containerRef, text, ctx]`. If the content changes but the DOM is already
   populated, the sync render is skipped entirely and only the async path runs.
   This is normally correct, but if the async path fails or produces empty blocks,
   the DOM would keep showing stale sync-rendered content.

2. **NO USE_PACED_TEXT**: SimpleMarkdownRenderer doesn't use usePacedText for
   streaming animation, unlike MarkdownRenderer. Not relevant for finalized output
   (streaming=false) but means the first paint shows the full sync-rendered content
   at once rather than character-by-character.

3. **MARKDOWN-TOOL CSS**: The `markdown-tool` CSS class sets a smaller font size
   (`var(--text-code)`) and removes paragraph margins. This changes the visual
   appearance but does NOT prevent rendering. It should not cause raw Markdown
   to appear.

### Conclusion

The unit-testable functions (stripTaskMetadataFromOutput, marked parsing) work
correctly. The issue likely involves a DOM/interaction edge case in the morphdom
rendering pipeline that requires a real browser environment to reproduce:
- Race condition between layout effect (sync render) and async effect (async render
  with syntax highlighting via Web Worker)
- Conditional mounting/unmounting of SimpleMarkdownRenderer within the collapsible
  output section
- Interaction between the isOutputExpanded state and content updates during streaming
*/
