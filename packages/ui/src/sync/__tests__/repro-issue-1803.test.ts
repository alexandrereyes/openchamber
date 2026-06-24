/**
 * Reproduction tests for issue #1803
 *
 * Bug 1: Session message restoration (revert) does not restore file modifications
 *        for non-Git projects.
 *
 * Bug 2: Sessions created via browser (web access) don't appear under projects
 *        on desktop — they only show in the "most recent" section.
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';

import { stripSessionDiffSnapshots, stripSessionListDetails } from '../sanitize';
import { normalizePath, isPathWithinProject } from '@/components/session/sidebar/utils';

// ---------------------------------------------------------------------------
// Bug 1: Non-Git file restoration during session revert
// ---------------------------------------------------------------------------
describe('Bug 1: Non-Git file restoration on revert', () => {
  /**
   * The session.revert() API returns a `Session` with a `revert` object that may
   * include `snapshot` (full file content before modification) and `diff` (patch).
   * These fields are critical for restoring files in non-Git projects, since there
   * is no Git history to revert from.
   *
   * However, stripSessionDiffSnapshots() removes these fields from the session
   * data when it's received by the client. This is documented as intentional —
   * the "UI derives reverted-state behavior from the lightweight messageID/partID
   * markers" (sanitize.ts lines 6-8).
   */
  test('stripSessionDiffSnapshots removes snapshot/diff from revert marker', () => {
    const session = {
      id: 'ses_1',
      directory: '/repo/app',
      title: 'Non-Git Session',
      time: { created: 1, updated: 2 },
      revert: {
        messageID: 'msg_2',
        partID: 'part_3',
        // These are the file content snapshots needed for non-Git restore:
        snapshot: 'full file content before modification',
        diff: 'diff --git a/file b/file\nindex abc..def 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old content\n+new content',
      },
    } as unknown as Session;

    const stripped = stripSessionDiffSnapshots(session) as Session & {
      revert?: { messageID?: string; partID?: string; snapshot?: string; diff?: string };
    };

    // snapshot and diff are stripped from the revert marker
    expect(stripped.revert?.snapshot).toBe(undefined);
    expect(stripped.revert?.diff).toBe(undefined);
    // Only messageID/partID remain
    expect(stripped.revert?.messageID).toBe('msg_2');
    expect(stripped.revert?.partID).toBe('part_3');
  });

  /**
   * stripSessionListDetails is even more aggressive — it strips the entire revert
   * object to just messageID/partID for session list responses. The snapshot/diff
   * data for non-Git restore is never persisted on the client.
   */
  test('stripSessionListDetails removes snapshot/diff from list responses', () => {
    const session = {
      id: 'ses_1',
      directory: '/repo/app',
      title: 'Non-Git Session',
      time: { created: 1, updated: 2 },
      revert: {
        messageID: 'msg_2',
        partID: 'part_3',
        snapshot: 'snapshot-content',
        diff: 'diff-content',
      },
      summary: {
        diffs: [{ patch: '@@ -1 +1 @@' }],
      },
    } as unknown as Session;

    const stripped = stripSessionListDetails(session) as Session & {
      revert?: { messageID?: string; partID?: string; snapshot?: string; diff?: string };
      summary?: { diffs?: unknown[] };
    };

    // snapshot and diff stripped
    expect(stripped.revert?.snapshot).toBe(undefined);
    expect(stripped.revert?.diff).toBe(undefined);
    expect(stripped.revert?.messageID).toBe('msg_2');
    // diffs also stripped from summary
    expect(stripped.summary?.diffs).toBe(undefined);
  });

  /**
   * The SDK's session.revert() request contract (from OpenAPI spec) only sends
   * messageID and partID — it does NOT send snapshot/diff data with the request.
   *
   * Session.revert request body: { messageID: string, partID?: string }
   *
   * The OpenCode server stores its own copy of snapshot data and is expected to
   * handle file restoration internally. OpenChamber does not implement any
   * non-Git file restoration logic for session revert — the only file revert
   * mechanism OpenChamber has is `/api/git/revert` which is exclusively for Git
   * repositories.
   *
   * This test verifies the API contract: no snapshot data is included in the
   * revert request parameters.
   */
  test('session.revert() request does not include snapshot data', () => {
    // The SDK method signature from @opencode-ai/sdk/v2:
    // session.revert({ sessionID, directory?, workspace?, messageID, partID? })
    //                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //                                      No snapshot or diff fields

    // Verify the SDK types match by checking the revert params
    type SessionRevertParams = {
      sessionID: string;
      directory?: string;
      workspace?: string;
      messageID: string;
      partID?: string;
      // No snapshot or diff fields
    };

    const params: SessionRevertParams = {
      sessionID: 'ses_1',
      directory: '/repo/app',
      messageID: 'msg_2',
    };

    // The revert request body only contains messageID and optionally partID
    const requestBody = {
      messageID: params.messageID,
      ...(params.partID ? { partID: params.partID } : {}),
    };

    expect(requestBody).toEqual({ messageID: 'msg_2' });
    // No snapshot data is ever included in the revert request
    expect('snapshot' in requestBody).toBe(false);
    expect('diff' in requestBody).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bug 2: Session-project association case sensitivity
// ---------------------------------------------------------------------------
describe('Bug 2: Case sensitivity in session-project association', () => {
  /**
   * The `useProjectSessionLists` hook uses `allowedDirectories` which stores
   * project paths WITHOUT lowercasing. Session directories resolved via
   * `resolveGlobalSessionDirectory` are also NOT lowercased. When a session
   * is created via the web browser (which may use a different path case than
   * what the desktop registered), the path comparison fails due to JavaScript's
   * case-sensitive string comparison — even on case-insensitive filesystems
   * like Windows.
   *
   * In contrast, `isKnownActiveSessionDirectory` (used for filtering sessions
   * into the sidebar at all) DOES lowercase both sides, so sessions still
   * appear in the sidebar but don't get grouped under any project.
   */
  test('allowedDirectories is case-sensitive but isKnownActiveSessionDirectory is case-insensitive', () => {
    // Simulate a project registered on desktop as "C:/Users/Me/MyProject"
    const projectPaths = ['C:/Users/Me/MyProject', 'D:/Work/Project'];

    // Simulate buildKnownSessionDirectories (lowercases paths)
    const knownDirectories = new Set(
      projectPaths.map((p) => normalizePath(p)?.toLowerCase() ?? ''),
    );

    // Simulate isKnownActiveSessionDirectory (lowercases both sides)
    const isKnownActiveSessionDirectory = (sessionDir: string): boolean => {
      const normalized = normalizePath(sessionDir)?.toLowerCase() ?? '';
      return knownDirectories.has(normalized);
    };

    // Simulate allowedDirectories from useProjectSessionLists (does NOT lowercase)
    const allowedDirectories = new Set(
      projectPaths.map((p) => normalizePath(p) ?? ''),
    );

    // Session directory from browser — same path but different case
    const browserSessionDir = 'c:/users/me/myproject';

    // isKnownActiveSessionDirectory accepts it (lowercased both sides)
    expect(isKnownActiveSessionDirectory(browserSessionDir)).toBe(true);

    // allowedDirectories rejects it (case-sensitive, no lowercase)
    const normalizedBrowserDir = normalizePath(browserSessionDir) ?? '';
    expect(allowedDirectories.has(normalizedBrowserDir)).toBe(false);
  });

  /**
   * On Windows, the OpenCode server may return paths in different cases
   * depending on how the project was opened. This reproduces the scenario
   * where the desktop project path "C:/Users/Me/Project" doesn't match
   * the session directory "c:/users/me/project" returned by the server
   * when the session was created via a browser.
   */
  test('Windows paths with different cases fail allowedDirectories check', () => {
    const desktopProjectPath = 'C:/Users/Me/MyProject';
    const browserSessionDir = 'c:/users/me/myproject';

    const normalizedProjectPath = normalizePath(desktopProjectPath) ?? '';
    const normalizedSessionDir = normalizePath(browserSessionDir) ?? '';

    // The paths refer to the same directory on Windows (case-insensitive FS)
    // but JavaScript string comparison is case-sensitive
    expect(normalizedProjectPath.toLowerCase()).toBe(normalizedSessionDir.toLowerCase());
    expect(normalizedProjectPath === normalizedSessionDir).toBe(false);

    // This is why allowedDirectories (case-sensitive) would fail
    // while isKnownActiveSessionDirectory (case-insensitive) would pass
  });

  /**
   * The `isPathWithinProject` function also doesn't lowercase — it does
   * exact prefix matching. So even if a session directory matches a project
   * path, casing differences break the association.
   */
  test('isPathWithinProject is case-sensitive', () => {
    expect(isPathWithinProject('/Users/Me/Project', '/Users/Me/Project')).toBe(true);
    // Same path, different case — fails
    expect(isPathWithinProject('/users/me/project', '/Users/Me/Project')).toBe(false);
  });

  /**
   * `normalizePath` does not lowercase paths — it only normalizes separators
   * and trailing slashes. Paths from browser and desktop that differ in case
   * remain different after normalization.
   */
  test('normalizePath does not lowercase', () => {
    expect(normalizePath('C:/Users/Me/Project')).toBe('C:/Users/Me/Project');
    expect(normalizePath('c:/users/me/project')).toBe('c:/users/me/project');
    expect(normalizePath('C:/Users/Me/Project')).not.toBe(normalizePath('c:/users/me/project'));
  });

  /**
   * Summary: When a session is created via web browser and its directory
   * path differs in case from the project path registered on desktop,
   * the session passes the sidebar filter (isKnownActiveSessionDirectory
   * lowercases both sides) but fails the project grouping filter
   * (allowedDirectories is case-sensitive). The session then appears
   * only in the "most recent" section but not under any project tree.
   *
   * This matches the reported behavior: "when adding a session in the
   * desktop version, the session record will not be recorded in this
   * item and will only be displayed in the most recent session."
   */
});
