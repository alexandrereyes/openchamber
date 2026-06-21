import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const MESSAGE_BODY_PATH = path.resolve(
    import.meta.dirname,
    '../message/MessageBody.tsx',
);

const DROPDOWN_PATH = path.resolve(
    import.meta.dirname,
    '../TurnChangedFilesDropdown.tsx',
);

describe('TurnChangedFilePills clickability', () => {
    test('TurnChangedFilePills renders <span> elements without onClick (BUG-1756)', () => {
        const source = fs.readFileSync(MESSAGE_BODY_PATH, 'utf-8');

        // Verify the component renders <span> as the TooltipTrigger child (not <button>)
        const hasButtonTrigger = />\s*<TooltipTrigger asChild>\s*\n?\s*<button\b/.test(source);
        const hasSpanTrigger = />\s*<TooltipTrigger asChild>\s*\n?\s*<span\b/.test(source);

        // Verify pills use <span> triggers (not clickable)
        expect(hasSpanTrigger).toBe(true);
        // Verify pills do NOT use <button> triggers
        expect(hasButtonTrigger).toBe(false);

        // Verify no onClick handler on pill elements
        // The only onClick in the component could be from other parts of MessageBody
        // Find the TurnChangedFilePills block specifically
        const pillsBlock = source.match(/const TurnChangedFilePills[\s\S]*?^}\);/m);
        if (pillsBlock) {
            const block = pillsBlock[0];
            // No onClick in the pills component
            expect(block.includes('onClick')).toBe(false);
            // No cursor-pointer in the pills component
            expect(block.includes('cursor-pointer')).toBe(false);
            // No button in the pills component
            expect(block.includes('<button')).toBe(false);
        } else {
            // Fallback: just check there's no onClick in the span-centric pattern
            const tooltipTriggerSpans = source.match(/<TooltipTrigger asChild>[\s\S]*?<\/TooltipTrigger>/g);
            const pillTriggers = tooltipTriggerSpans?.filter(t => t.includes('<span') && !t.includes('cursor-pointer'));
            expect(pillTriggers?.length).toBeGreaterThanOrEqual(1);
        }
    });

    test('TurnChangedFilePills pills are <span> with no interactive semantics (BUG-1756)', () => {
        const source = fs.readFileSync(MESSAGE_BODY_PATH, 'utf-8');

        // Find the TurnChangedFilePills return statement
        const pillsSection = source.match(/const TurnChangedFilePills[\s\S]*?^}\);/m);
        expect(pillsSection).not.toBeNull();
        const block = pillsSection![0];

        // The file name display uses <span> elements with no role, tabIndex, or onClick
        // Specifically, the pill that shows file name and +N/-M stats is a <span>
        // No role="button" or role="link" on any element
        expect(block.includes('role="button"')).toBe(false);
        expect(block.includes('role="link"')).toBe(false);
        expect(block.includes('tabIndex')).toBe(false);

        // The only interactive element pattern should be TooltipTrigger
        // which only handles hover, not click
        expect(block).toMatch(/TooltipTrigger/);
        expect(block).toMatch(/TooltipContent/);
    });

    test('TurnChangedFilesDropdown uses <button> as trigger (controls: clickable)', () => {
        const source = fs.readFileSync(DROPDOWN_PATH, 'utf-8');

        // Verify the dropdown trigger is a <button> element
        expect(source.includes('<button')).toBe(true);
        expect(source.includes('type="button"')).toBe(true);

        // Verify interaction handlers exist
        expect(source.includes('onPointerDownCapture')).toBe(true);
        expect(source.includes('onFocusCapture')).toBe(true);

        // Verify it's wrapped in Popover.Trigger (click-to-toggle)
        expect(source.includes('Popover.Trigger')).toBe(true);
    });

    test('Contrast: dropdown entries are clickable, pills are not (BUG-1756)', () => {
        // TurnChangedFilesDropdown popover entries: each is a <button> with onClick
        const changedFilesListSource = fs.readFileSync(
            path.resolve(import.meta.dirname, '../ChangedFilesList.tsx'),
            'utf-8',
        );
        expect(changedFilesListSource.includes('<button')).toBe(true);
        expect(changedFilesListSource.includes('onClick={() => onOpenFile(file)}')).toBe(true);
        expect(changedFilesListSource.includes('cursor-pointer')).toBe(true);

        // TurnChangedFilePills: each pill is a plain <span>, no click handling
        const messageBodySource = fs.readFileSync(MESSAGE_BODY_PATH, 'utf-8');
        const pillsBlock = messageBodySource.match(/const TurnChangedFilePills[\s\S]*?^}\);/m);
        expect(pillsBlock).not.toBeNull();
        const block = pillsBlock![0];

        expect(block.includes('<button')).toBe(false);
        expect(block.includes('onClick')).toBe(false);
        expect(block.includes('cursor-pointer')).toBe(false);

        // The pills only have hover tooltip, no click-to-open-file behavior
        // This is the bug: completed turn file summaries should be clickable
        // to open the file, but they are not.
    });
});
