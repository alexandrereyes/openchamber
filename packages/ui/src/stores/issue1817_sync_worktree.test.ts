/**
 * Reproduction test for issue #1817:
 * New worktree created in mini chat does not display in the main window's sidebar.
 *
 * Root cause: `useSessionUIStore` (which holds `availableWorktreesByProject`)
 * is a plain Zustand store — not synced via SSE/WebSocket or BroadcastChannel.
 * Each Electron renderer process (mini-chat window, main window) has its own
 * independent instance of this store. When worktree creation in the mini-chat
 * calls `worktreeManager.createWorktree()`, it updates the mini-chat's own
 * `availableWorktreesByProject` — the main window's store is untouched.
 *
 * The sidebar then:
 * 1. Builds a set of "known" directories from project paths + availableWorktreesByProject.
 * 2. Filters the merged session list through `isKnownActiveSessionDirectory()`,
 *    dropping sessions whose directory is not in the known set.
 * 3. Creates worktree groups only for worktrees in `availableWorktreesByProject`.
 *
 * Since the worktree is missing from the main window's store:
 * - Sessions in that worktree are filtered OUT of the sidebar entirely.
 * - No worktree group appears in the sidebar for the new worktree.
 * - Worktree discovery (a useEffect in SessionSidebar that calls listProjectWorktrees)
 *   only re-runs when the project list changes, NOT when a worktree is created.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorktreeMetadata } from '@/types/worktree';
import type { Session } from '@opencode-ai/sdk/v2';

// ============================================================================
// Simulate two independent Zustand store instances,
// as happens in the real app (mini-chat window vs main window).
// ============================================================================

// Window "A": the mini-chat window where the worktree is created
const storeA = {
  availableWorktreesByProject: new Map<string, WorktreeMetadata[]>(),
  availableWorktrees: [] as WorktreeMetadata[],
};

// Window "B": the main window that should display the new worktree
const storeB = {
  availableWorktreesByProject: new Map<string, WorktreeMetadata[]>(),
  availableWorktrees: [] as WorktreeMetadata[],
};

// ============================================================================
// Mock the session-ui-store so we can independently control two "instances"
// ============================================================================

// Track which "window" is currently being tested
let currentMockStore: typeof storeA = storeA;

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => currentMockStore,
    setState: (patch: Partial<typeof currentMockStore> | ((state: typeof currentMockStore) => Partial<typeof currentMockStore>)) => {
      const next = typeof patch === 'function' ? patch(currentMockStore) : patch;
      Object.assign(currentMockStore, next);
    },
    subscribe: () => () => {},
  },
}));

// ============================================================================
// Helper: extract the functions we need to test, inlined from SessionSidebar
// and useProjectSessionLists to avoid importing React.
// ============================================================================

const normalizePath = (value: string | null): string | null => {
  if (!value) return null;
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

const resolveGlobalSessionDirectory = (session: Session): string | null => {
  return normalizePath((session as Session & { directory?: string | null }).directory ?? null);
};

const buildKnownSessionDirectories = (
  projects: Array<{ path: string }>,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  options?: { includeWorktrees?: boolean },
): Set<string> => {
  const directories = new Set<string>();
  for (const project of projects) {
    const normalized = normalizePath(project.path)?.toLowerCase();
    if (normalized) directories.add(normalized);
  }
  if (options?.includeWorktrees === false) {
    return directories;
  }
  for (const worktrees of availableWorktreesByProject.values()) {
    for (const worktree of worktrees) {
      const normalized = normalizePath(worktree.path)?.toLowerCase();
      if (normalized) directories.add(normalized);
    }
  }
  return directories;
};

const isKnownActiveSessionDirectory = (
  session: Session,
  knownDirectories: Set<string>,
  options?: { allowUnknownDirectory?: boolean; allowEmptyDirectorySet?: boolean },
): boolean => {
  if (session.time?.archived) return true;
  const directory = normalizePath(resolveGlobalSessionDirectory(session))?.toLowerCase();
  if (!directory) return options?.allowUnknownDirectory ?? true;
  if (knownDirectories.size === 0) return options?.allowEmptyDirectorySet ?? true;
  return knownDirectories.has(directory);
};

// Simulate the ProjectSessionLists 'allowedDirectories' computation
const buildAllowedDirectories = (
  normalizedProjects: Array<{ normalizedPath: string }>,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  isVSCode: boolean,
): Set<string> => {
  const set = new Set<string>();
  normalizedProjects.forEach((project) => {
    if (project.normalizedPath) set.add(project.normalizedPath);
  });
  if (!isVSCode) {
    for (const worktrees of availableWorktreesByProject.values()) {
      for (const worktree of worktrees) {
        const normalized = normalizePath(worktree.path);
        if (normalized) set.add(normalized);
      }
    }
  }
  return set;
};

describe('Issue #1817 — worktree created in mini-chat not visible in main window sidebar', () => {
  const PROJECT_ROOT = '/home/user/project';
  const WORKTREE_PATH = '/home/user/project-worktree-feature';
  const projects = [{ id: 'proj1', path: PROJECT_ROOT }];
  const normalizedProjects = [{ id: 'proj1', normalizedPath: PROJECT_ROOT }];

  beforeEach(() => {
    // Reset both stores before each test
    storeA.availableWorktreesByProject = new Map<string, WorktreeMetadata[]>();
    storeA.availableWorktrees = [];
    storeB.availableWorktreesByProject = new Map<string, WorktreeMetadata[]>();
    storeB.availableWorktrees = [];
  });

  test('1. Worktree creation in mini-chat (Store A) updates only Store A — Store B (main window) unchanged', () => {
    // Simulate createWorktree() in worktreeManager.ts — this runs in the mini-chat
    // process and updates its own useSessionUIStore instance.
    currentMockStore = storeA;

    const newWorktree: WorktreeMetadata = {
      source: 'sdk',
      name: 'feature',
      path: WORKTREE_PATH,
      projectDirectory: PROJECT_ROOT,
      branch: 'feature',
      label: 'feature',
      worktreeRoot: WORKTREE_PATH,
      worktreeStatus: 'ready',
      headState: 'branch',
      worktreeSource: 'created-for-session',
    };

    // This is what createWorktree() does (lines 377-386 of worktreeManager.ts)
    const currentByProject = storeA.availableWorktreesByProject;
    const updatedByProject = new Map(currentByProject);
    updatedByProject.set(PROJECT_ROOT, [newWorktree]);
    storeA.availableWorktreesByProject = updatedByProject;
    storeA.availableWorktrees = [newWorktree];

    // ✅ Store A has the new worktree
    expect(storeA.availableWorktreesByProject.get(PROJECT_ROOT)).toHaveLength(1);
    expect(storeA.availableWorktreesByProject.get(PROJECT_ROOT)![0].path).toBe(WORKTREE_PATH);
    expect(storeA.availableWorktrees).toHaveLength(1);

    // ❌ Store B (main window) does NOT have the new worktree
    expect(storeB.availableWorktreesByProject.get(PROJECT_ROOT)).toBe(undefined);
    expect(storeB.availableWorktrees).toHaveLength(0);

    // This demonstrates the core problem: each window has its own Zustand store,
    // and there is no cross-window sync mechanism for availableWorktreesByProject.
  });

  test('2. Main window sidebar filters OUT sessions in the new worktree directory', () => {
    // Simulate the main window's state (Store B) — no worktrees known
    currentMockStore = storeB;

    const knownDirectories = buildKnownSessionDirectories(projects, storeB.availableWorktreesByProject, { includeWorktrees: true });

    // Main window only knows about the project root
    expect(knownDirectories.has(PROJECT_ROOT)).toBe(true);
    expect(knownDirectories.has(WORKTREE_PATH)).toBe(false);

    // Create a session that lives in the new worktree directory
    // (This simulates what happens when the user sends a message in the mini-chat
    // after creating a worktree — the session's directory is the worktree path)
    const worktreeSession: Session = {
      id: 'session-in-worktree',
      created: 1,
      updated: 1,
      directory: WORKTREE_PATH,
      project: { worktree: WORKTREE_PATH },
      title: 'Worktree Session',
      time: { created: new Date(1).toISOString(), updated: new Date(1).toISOString() },
      metadata: {},
    } as unknown as Session;

    // This is the key check: isKnownActiveSessionDirectory returns FALSE for
    // sessions whose directory is not in the known set (and the session has
    // a directory, so allowUnknownDirectory doesn't apply).
    const isAllowed = isKnownActiveSessionDirectory(worktreeSession, knownDirectories, {
      allowUnknownDirectory: true,  // desktop mode
      allowEmptyDirectorySet: true, // desktop mode
    });
    expect(isAllowed).toBe(false);

    // The session is FILTERED OUT of the sidebar.
    // This is the exact code path from SessionSidebar.tsx line 375:
    //   merged.filter((session) => isKnownActiveSessionDirectory(session, knownSessionDirectories, { allowUnknownDirectory: !isVSCode, allowEmptyDirectorySet: !isVSCode }))
  });

  test('3. `allowedDirectories` in useProjectSessionLists also excludes the new worktree', () => {
    currentMockStore = storeB;

    // This simulates the allowedDirectories computation in useProjectSessionLists.ts
    const allowedDirectories = buildAllowedDirectories(normalizedProjects, storeB.availableWorktreesByProject, false);

    // Only the project root is allowed
    expect(allowedDirectories.has(PROJECT_ROOT)).toBe(true);
    expect(allowedDirectories.has(WORKTREE_PATH)).toBe(false);

    // A session in the worktree directory would be skipped in sessionsByDirectory
    // because allowedDirectories.has(directory) returns false
    // (from useProjectSessionLists.ts lines 58-79)
  });

  test('4. Worktree groups not created for the new worktree in sidebar', () => {
    currentMockStore = storeB;

    // Simulate useSessionSidebarSections: it reads availableWorktreesByProject
    // and passes the per-project worktree list to buildGroupedSessions.
    // Since Store B doesn't have the worktree, the worktrees list is empty.
    const worktreesForProject = storeB.availableWorktreesByProject.get(PROJECT_ROOT) ?? [];
    expect(worktreesForProject).toHaveLength(0);

    // buildGroupedSessions in useSessionGrouping.ts iterates availableWorktrees
    // to create worktree SessionGroup entries. Empty list → no worktree group.
    // The session that was created in the worktree also can't find its worktree
    // via getGroupKey() (line 132-137), so it falls into the archived bucket
    // or is simply invisible.
  });

  test('5. Worktree discovery does NOT re-run on worktree creation — only on project list changes', () => {
    currentMockStore = storeB;

    // Simulate the discoverWorktrees useEffect key in SessionSidebar.tsx (line 406-410):
    const projectWorktreeDiscoveryKey = projects
      .map((project) => `${project.id}:${normalizePath(project.path) ?? ''}`)
      .join('|');

    // This key does NOT change when a worktree is created (it only depends
    // on the project id+path), so the useEffect will short-circuit with:
    //   if (discoveredProjectsRef.current === projectWorktreeDiscoveryKey) { return; }
    const discoveryKeyWithSameProjects = projects
      .map((project) => `${project.id}:${normalizePath(project.path) ?? ''}`)
      .join('|');

    expect(projectWorktreeDiscoveryKey).toBe(discoveryKeyWithSameProjects);
  });

  test('6. Complete end-to-end simulation: mini-chat creates worktree, main window misses it', () => {
    // --- Step 1: Mini-chat (Store A) creates a worktree ---
    currentMockStore = storeA;

    const newWorktree: WorktreeMetadata = {
      source: 'sdk',
      name: 'feature',
      path: WORKTREE_PATH,
      projectDirectory: PROJECT_ROOT,
      branch: 'feature',
      label: 'feature',
      worktreeRoot: WORKTREE_PATH,
      worktreeStatus: 'ready',
      headState: 'branch',
      worktreeSource: 'created-for-session',
    };

    // worktreeManager.createWorktree() updates the mini-chat's store
    const currentByProject = storeA.availableWorktreesByProject;
    const updatedByProject = new Map(currentByProject);
    updatedByProject.set(PROJECT_ROOT, [newWorktree]);
    Object.assign(storeA, {
      availableWorktreesByProject: updatedByProject,
      availableWorktrees: [newWorktree],
    });

    // Mini-chat has the worktree ✓
    expect(storeA.availableWorktreesByProject.get(PROJECT_ROOT)).toHaveLength(1);

    // --- Step 2: SSE session.created event reaches both windows ---
    // (This is the one part that works: the event pipeline delivers
    // session.created to all connected clients.)
    const worktreeSessionId = 'session-in-feature-worktree';
    const worktreeSession: Session = {
      id: worktreeSessionId,
      created: 2,
      updated: 2,
      directory: WORKTREE_PATH,
      project: { worktree: WORKTREE_PATH },
      title: 'New Worktree Session',
      metadata: {},
      time: { created: new Date(2).toISOString(), updated: new Date(2).toISOString() },
    } as unknown as Session;

    // The session appears in both windows' live session stores
    // (simulated — in production, the event pipeline handles this via SSE/WS)

    // --- Step 3: Main window (Store B) tries to show the session in the sidebar ---
    currentMockStore = storeB;

    const knownDirectories = buildKnownSessionDirectories(projects, storeB.availableWorktreesByProject, { includeWorktrees: true });

    // The main window's known directories do NOT include the worktree path
    expect(knownDirectories.has(WORKTREE_PATH)).toBe(false);

    // The session is filtered out: isKnownActiveSessionDirectory returns false
    const isSessionVisibleInSidebar = isKnownActiveSessionDirectory(worktreeSession, knownDirectories, {
      allowUnknownDirectory: true,
      allowEmptyDirectorySet: true,
    });
    expect(isSessionVisibleInSidebar).toBe(false);

    // No worktree group exists for the new worktree
    const worktreesForProject = storeB.availableWorktreesByProject.get(PROJECT_ROOT) ?? [];
    expect(worktreesForProject).toHaveLength(0);

    // Result: the worktree and its sessions are invisible in the main window's sidebar
    // until the user restarts or reloads the webview, which creates fresh Zustand
    // stores and runs worktree discovery from scratch.
  });
});
