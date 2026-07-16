/**
 * Reproduction test for issue #2270:
 * New sessions from nested Git projects target a sibling child project.
 *
 * Root cause: When a child project has no Git repository of its own,
 * worktree discovery walks up to the nearest parent Git repo and
 * returns worktrees scoped to that parent. Those worktrees' paths
 * (e.g. the parent repo root) can be a prefix of sibling project
 * directories. `resolveProjectFromWorktreeDirectory` then finds a
 * worktree match for the wrong project and, via its exact-match
 * fallback on `matchedProjectPath`, returns the sibling project
 * instead of the correct one.
 */

import { describe, expect, test } from 'bun:test';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';

/**
 * Helper: build a minimal ProjectEntry.
 */
const project = (id: string, path: string): ProjectEntry => ({
  id,
  path,
});

/**
 * Helper: build a minimal WorktreeMetadata.
 */
const worktree = (
  path: string,
  projectDirectory: string,
  overrides: Partial<WorktreeMetadata> = {},
): WorktreeMetadata => ({
  source: 'sdk',
  name: 'main',
  path,
  projectDirectory,
  branch: 'main',
  label: 'main',
  worktreeRoot: path,
  worktreeStatus: 'ready',
  headState: 'branch',
  worktreeSource: 'existing',
  ...overrides,
});

describe('resolveProjectForSessionDirectory (issue #2270)', () => {
  /**
   * Scenario: Parent Git repo at /workspace, three child projects:
   *   project-a at /workspace/project-a (NO own Git)
   *   project-b at /workspace/project-b (has own Git)
   *   project-c at /workspace/project-c (has own Git)
   *
   * Worktree discovery for project-a walks UP to the parent repo at /workspace
   * and returns a worktree entry with path=/workspace, projectDirectory=/workspace.
   * That worktree is stored under project-a's key in availableWorktreesByProject.
   *
   * When resolving a session directory under project-b, the worktree at /workspace
   * (which is a prefix of /workspace/project-b/...) is matched. The function then
   * resolves to project-a (via exact match on matchedProjectPath), which is WRONG.
   */
  test('returns the correct project for a directory inside a nested child repo (bug: returns sibling without Git)', () => {
    const projects: ProjectEntry[] = [
      project('project-a', '/workspace/project-a'),
      project('project-b', '/workspace/project-b'),
      project('project-c', '/workspace/project-c'),
    ];

    // Worktree discovery for project-a (no own Git) walks up to parent repo /workspace
    // and returns the primary worktree at /workspace with projectDirectory=/workspace
    const availableWorktreesByProject = new Map<string, WorktreeMetadata[]>([
      [
        '/workspace/project-a',
        [
          worktree('/workspace', '/workspace'), // leaked parent repo worktree
        ],
      ],
      [
        '/workspace/project-b',
        [], // project-b has its own Git; no worktrees or empty
      ],
      [
        '/workspace/project-c',
        [], // same
      ],
    ]);

    // The session directory is inside project-b
    const directory = '/workspace/project-b/some-subdir';

    const result = resolveProjectForSessionDirectory(
      projects,
      availableWorktreesByProject,
      directory,
    );

    // BUG: resolveProjectFromWorktreeDirectory finds the worktree at /workspace
    // (stored under project-a's key), matches it because /workspace/project-b/...
    // starts with /workspace/, then resolves to project-a via exact match on
    // matchedProjectPath="/workspace/project-a".
    // EXPECTED: project-b, but the bug returns project-a.
    expect(result?.id).not.toBe('project-a');
    expect(result?.id).toBe('project-b');
  });

  /**
   * Control case: when NO project has worktrees that leak from a parent repo,
   * resolveProjectForSessionDirectory correctly falls through to the simple
   * longest-prefix path-based resolution.
   */
  test('resolves correctly via fallback when no worktrees are present', () => {
    const projects: ProjectEntry[] = [
      project('project-a', '/workspace/project-a'),
      project('project-b', '/workspace/project-b'),
      project('project-c', '/workspace/project-c'),
    ];

    const availableWorktreesByProject = new Map<string, WorktreeMetadata[]>([
      ['/workspace/project-a', []],
      ['/workspace/project-b', []],
      ['/workspace/project-c', []],
    ]);

    const result = resolveProjectForSessionDirectory(
      projects,
      availableWorktreesByProject,
      '/workspace/project-b/some-subdir',
    );

    // Falls through to resolveProjectForDirectory: longest prefix match → project-b
    expect(result?.id).toBe('project-b');
  });

  /**
   * Control case: when the parent repo IS also a registered project,
   * the worktree-based resolution matches the parent project exactly,
   * which may still be wrong from the user's perspective, but it's
   * at least a direct match on the worktree's projectDirectory.
   */
  test('when parent is also a project, matches the parent via exact match on projectDirectory', () => {
    const projects: ProjectEntry[] = [
      project('parent', '/workspace'),
      project('project-a', '/workspace/project-a'),
      project('project-b', '/workspace/project-b'),
    ];

    const availableWorktreesByProject = new Map<string, WorktreeMetadata[]>([
      [
        '/workspace/project-a',
        [
          worktree('/workspace', '/workspace'),
        ],
      ],
      ['/workspace/project-b', []],
    ]);

    const result = resolveProjectForSessionDirectory(
      projects,
      availableWorktreesByProject,
      '/workspace/project-b',
    );

    // The worktree's projectDirectory="/workspace" exactly matches the parent
    // project. This is also arguably wrong behavior (the user clicked project-b),
    // but demonstrates a different failure mode.
    expect(result?.id).toBe('parent');
  });
});
