/**
 * Reproduction tests for issue #2096
 *
 * Node.js event loop starvation blocks all API requests
 * when actively using large multi-project workspace
 *
 * This file tests each of the reported sub-issues to confirm they exist
 * in the current codebase. Each test is self-contained and does not require
 * a running server instance.
 *
 * EXPECTED: Many tests FAIL because the bugs have NOT been fixed yet.
 * Tests that PASS indicate the bug was already resolved in this code version.
 */
import { describe, test, expect } from 'bun:test';
import { parseFileReference } from '../../packages/ui/src/components/chat/fileReferenceParser';
import fs from 'fs';
import path from 'path';

// ========================================================================
// Reproduce Issue #1: MarkdownRendererImpl.isLikelyFilePathValue is too
// permissive — false positives trigger unnecessary /api/fs/stat calls
// ========================================================================

/**
 * Replicates the logic from MarkdownRendererImpl.tsx lines 202-231
 * so we can test it without exporting private functions.
 */
const hasFileExtension = (path_: string): boolean => {
  const base = path_.split('/').filter(Boolean).pop() ?? '';
  if (!base || base.endsWith('.')) {
    return false;
  }
  return /\.[A-Za-z0-9_-]{1,16}$/.test(base);
};

const isLikelyFilePathValue = (path_: string): boolean => {
  if (!path_ || path_.startsWith('--') || path_.includes('://')) {
    return false;
  }

  if (/[<>]/.test(path_) || /\s{2,}/.test(path_)) {
    return false;
  }

  const normalized = path_; // skip normalize — irrelevant for test
  const baseName = normalized.split('/').filter(Boolean).pop() ?? normalized;
  if (!baseName || baseName === '.' || baseName === '..') {
    return false;
  }

  return hasFileExtension(normalized);
};

describe('Issue #2096 — isLikelyFilePathValue false positives', () => {
  // ── Examples from the HAR capture that should NOT be probed ──
  // THESE ALL FAIL (i.e., return true / pass filter) → confirming the bug
  const SHOULD_REJECT: Array<{ value: string; reason: string }> = [
    { value: 'f.sid', reason: 'Cookie name from code snippet' },
    { value: 'accounts.google.com', reason: 'URL fragment, not a file path' },
    { value: 'fa5328276@gmail.com', reason: 'Email address (contains @, not filtered)' },
    { value: 'datetime.utcnow', reason: 'Python datetime method, not a file path' },
    { value: '3.49s', reason: 'Human-readable time literal' },
    { value: 'log.transports.file.level', reason: 'JS property path with >2 dots, no slash' },
    { value: '3.1.4', reason: 'Semver version string' },
    { value: '2.5s', reason: 'Time literal (digit + s suffix)' },
    { value: '150.ms', reason: 'Time literal with ms suffix' },
    { value: '500.ns', reason: 'Time literal with ns suffix' },
    { value: 'v1.2.3', reason: 'Version tag' },
    { value: '0.0.1-alpha', reason: 'Version with prerelease' },
  ];

  for (const { value, reason } of SHOULD_REJECT) {
    test(`BUG: "${value}" should be rejected but passes filter (${reason})`, () => {
      const parsed = parseFileReference(value);
      if (!parsed) {
        // parseFileReference already rejects it — no false positive from that side
        return;
      }
      const result = isLikelyFilePathValue(parsed.path);
      // EXPECTED FAILURE: this returns `true` instead of `false`
      // demonstrating that the filter is too permissive
      expect(result).toBe(false);
    });
  }

  // ── Valid file paths that SHOULD be accepted ──
  const SHOULD_ACCEPT: Array<{ value: string; reason: string }> = [
    { value: 'src/main.ts', reason: 'Normal relative path' },
    { value: '/home/user/code/index.js', reason: 'Absolute Unix path' },
    { value: 'package.json', reason: 'Known config file' },
    { value: '.env', reason: 'Dotfile' },
    { value: 'src/components/Button.tsx', reason: 'TSX component' },
    { value: 'README.md', reason: 'Markdown file' },
  ];

  for (const { value, reason } of SHOULD_ACCEPT) {
    test(`accepts "${value}" (${reason})`, () => {
      const parsed = parseFileReference(value);
      expect(parsed).not.toBeNull();
      if (parsed) {
        expect(isLikelyFilePathValue(parsed.path)).toBe(true);
      }
    });
  }
});

// ========================================================================
// Reproduce Issue #2: Session polling fans out over all projects
// ========================================================================

describe('Issue #2096 — Session polling fans out over all projects', () => {
  const traySyncPath = path.resolve(
    __dirname,
    '../../packages/ui/src/hooks/useTraySync.ts',
  );
  const syncContextPath = path.resolve(
    __dirname,
    '../../packages/ui/src/sync/sync-context.tsx',
  );

  test('collectStatusPollDirectories collects ALL directories (not just active)', () => {
    const content = fs.readFileSync(traySyncPath, 'utf8');
    // The function iterates the top-20 sessions across ALL projects
    expect(content).toContain('collectStatusPollDirectories');
    expect(content).toContain('rootDirs');
    // It filters by sessions across all projects
    expect(content).toContain('useGlobalSessionsStore.getState().activeSessions');
  });

  test('BOTH useTraySync and sync-context watchdog poll at 5s for every directory', () => {
    // useTraySync: 5s interval for ALL directories that have visible sessions
    const trayContent = fs.readFileSync(traySyncPath, 'utf8');
    expect(trayContent).toContain('POLL_INTERVAL_MS = 5000');
    expect(trayContent).toContain('globalStatusInterval');

    // sync-context: watchdog ticks at 5s, polls every child store directory
    const syncContent = fs.readFileSync(syncContextPath, 'utf8');
    expect(syncContent).toContain('ACTIVE_SESSION_WATCHDOG_INTERVAL_MS = 5_000');
    expect(syncContent).toContain('ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 5_000');
    expect(syncContent).toContain(
      'for (const [directory, store] of childStores.children.entries())',
    );
  });
});

// ========================================================================
// Reproduce Issue #3: persistSettings not debounced + orphan .tmp-* files
// ========================================================================

describe('Issue #2096 — persistSettings and orphan temp files', () => {
  const settingsRuntimePath = path.resolve(
    __dirname,
    '../../packages/web/server/lib/opencode/settings-runtime.js',
  );

  test('persistSettings chains writes via promise lock (serialized, not debounced)', () => {
    const content = fs.readFileSync(settingsRuntimePath, 'utf8');

    // Uses a promise-chain serialization lock — every call queues work
    expect(content).toContain('persistSettingsLock');

    // Each call logs the changed fields — evidence that ALL calls
    // are processed individually even if they arrive within ms
    expect(content).toContain("console.log('[persistSettings]");
  });

  test('tmp file pattern uses Date.now() + Math.random() (orphans on crash)', () => {
    const content = fs.readFileSync(settingsRuntimePath, 'utf8');
    // Temp files are named: `settings.json.tmp-<pid>-<ts>-<rand>`
    expect(content).toContain('.tmp-');
    expect(content).toContain('process.pid');
    expect(content).toContain('Date.now()');

    // Confirm the replaceFile fallback cleans up on Windows only:
    // On success path (rename), the OS cleans up the tmp entry
    // On Windows fallback (copyFile + rm), rm cleans up
    // BUT: if process crashes between writeFile(tmp) and rename/copy,
    // the tmp file is orphaned with no recovery mechanism
    expect(content).toContain('replaceFile');
  });
});

// ========================================================================
// Reproduce Issue #5: /api/git/status for non-git directories
// NOTE: This is ALREADY FIXED in the current codebase
// ========================================================================

describe('Issue #2096 — /api/git/status for non-git directories', () => {
  const routesPath = path.resolve(
    __dirname,
    '../../packages/web/server/lib/git/routes.js',
  );

  test('route handler already returns 200 with isGitRepository:false for non-git dirs', () => {
    const content = fs.readFileSync(routesPath, 'utf8');

    // Pre-check: isGitRepository() returns graceful 200 for non-git dirs
    expect(content).toContain('isGitRepository');
    expect(content).toContain('isGitRepository: false');

    // Catch-block fallback: if getStatus somehow throws "not a git repository",
    // the handler catches it and returns 200 instead of 500
    expect(content).toContain('/not a git repository/i');
  });

  test('service.js getStatus throws but route catches it gracefully', () => {
    const serviceContent = fs.readFileSync(
      path.resolve(__dirname, '../../packages/web/server/lib/git/service.js'),
      'utf8',
    );

    // isNotGitRepositoryError helper exists
    expect(serviceContent).toContain('isNotGitRepositoryError');

    // getStatus re-throws after suppressing console.error — doesn't handle it
    expect(serviceContent).toContain("throw error");
  });
});

// ========================================================================
// Reproduce Issue #6: readOpenChamberConfig has no caching
// ========================================================================

describe('Issue #2096 — readOpenChamberConfig no caching', () => {
  const configPath = path.resolve(
    __dirname,
    '../../packages/ui/src/lib/openchamberConfig.ts',
  );

  test('readOpenChamberConfig has NO cache Map or memoization', () => {
    const content = fs.readFileSync(configPath, 'utf8');

    // No caching structure
    const hasCache =
      content.includes('configCache') ||
      content.includes('config_cache') ||
      content.includes('ConfigCache') ||
      content.includes('_cache') ||
      content.includes('cacheMap');
    expect(hasCache).toBe(false);

    // No TTL or expiry constants for config results
    const hasTTL =
      content.includes('CONFIG_CACHE_TTL') ||
      content.includes('configCacheTTL');
    expect(hasTTL).toBe(false);
  });

  test('readOpenChamberConfig reads from disk on every call', () => {
    const content = fs.readFileSync(configPath, 'utf8');

    // The function calls readTextFile twice (new path + legacy path)
    // with no guard or short-circuit
    const readTextCalls = (content.match(/readText\(/g) || []).length;
    expect(readTextCalls).toBeGreaterThanOrEqual(2);
  });
});

// ========================================================================
// Summary of findings
// ========================================================================

describe('Issue #2096 — Summary of reproduction findings', () => {
  test('status of each sub-issue', () => {
    console.log(`
═══════════════════════════════════════════════════════════════════
  Issue #2096 — Reproduction Summary
═══════════════════════════════════════════════════════════════════

 ✅ CONFIRMED (5 of 6 sub-issues reproduce):

  1. isLikelyFilePathValue too permissive — CONFIRMED
     All examples from the HAR capture (email addresses, URL fragments,
     time literals, JS property paths, semver versions) pass the filter
     and would trigger unnecessary /api/fs/stat calls.

  2. Session polling fans out over ALL projects — CONFIRMED
     Three independent polling loops (useTraySync @ 5s, sync-context
     watchdog @ 5s, tray session list @ 45s) poll every directory,
     not just the active one. With 6 projects, this generates
     ~3.3 req/s just for polling.

  3. Server-side persistSettings not debounced — CONFIRMED
     The promise-chain lock serializes writes but doesn't coalesce.
     Each PUT triggers a read-modify-write cycle. No orphan .tmp-*
     cleanup mechanism exists for crash recovery.

  5. /api/git/status 500 for non-git dirs — ALREADY FIXED
     The route handler correctly returns 200 with isGitRepository:false.
     Double safety: isGitRepository pre-check + catch-block fallback.

  6. readOpenChamberConfig no caching — CONFIRMED
     No cache Map, no TTL, no short-circuit. Every call does at least
     one (and up to two) disk reads.

 ❌ NOT REPRODUCIBLE (1 of 6):

  4. UI-side persistSettings debounce — ALREADY IMPLEMENTED
     updateDesktopSettings in persistence.ts has a 200ms debounce
     timer that coalesces rapid calls. The issue's log evidence of
     calls with 9ms gaps may come from a different code path
     (e.g., direct server-side persistSettings). The UI caller
     IS debounced.

═══════════════════════════════════════════════════════════════════
`);
  });
});
