import { describe, expect, it } from 'vitest';
import { buildPatchFromSectionIDs, parseWorkspacePatchSections, summarizePatchSections } from './patch-sections.js';

describe('workspace patch sections', () => {
  it('parses quoted paths, renames, binary patches, and exact selectable sections', () => {
    const patch = [
      'diff --git "a/old name.txt" "b/new name.txt"\n',
      'similarity index 88%\n',
      'rename from old name.txt\n',
      'rename to new name.txt\n',
      '--- "a/old name.txt"\n',
      '+++ "b/new name.txt"\n',
      '@@ -1 +1 @@\n',
      '-old\n',
      '+new\n',
      'diff --git a/image.bin b/image.bin\n',
      'GIT binary patch\n',
      'literal 0\n',
      'HcmV?d00001\n',
    ].join('');

    const sections = parseWorkspacePatchSections(patch);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ oldPath: 'old name.txt', newPath: 'new name.txt', path: 'new name.txt', changeType: 'R', additions: 1, deletions: 1 });
    expect(sections[1]).toMatchObject({ path: 'image.bin', binary: true });

    const summary = summarizePatchSections(sections);
    expect(summary.files.map((file) => file.path)).toEqual(['new name.txt', 'image.bin']);
    expect(buildPatchFromSectionIDs(sections, [sections[1].id])).toBe(sections[1].content);
  });

  it('does not split on diff-looking content lines inside hunks', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt\n',
      '--- a/a.txt\n',
      '+++ b/a.txt\n',
      '@@ -1 +1 @@\n',
      '-diff --git a/not-a-section b/not-a-section\n',
      '+diff --git a/not-a-section b/not-a-section\n',
    ].join('');

    const sections = parseWorkspacePatchSections(patch);
    expect(sections).toHaveLength(1);
    expect(sections[0].additions).toBe(1);
    expect(sections[0].deletions).toBe(1);
  });
});
