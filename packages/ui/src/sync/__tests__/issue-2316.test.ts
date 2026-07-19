/**
 * Reproduction test for issue #2316: Renaming session in sidebar not visible until restart.
 *
 * This test validates that after updateSessionTitle is called, both the
 * live child store and the global sessions store reflect the new title
 * immediately — and that the useAllLiveSessions/useGlobalSessionsStore
 * selectors would return the updated data on the next synchronous read.
 */

import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { Session, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"
import { create } from "zustand"

// ---------------------------------------------------------------------------
// Shared test helpers (mirroring the pattern from session-actions.test.ts)
// ---------------------------------------------------------------------------

type SessionWithDirectory = Session & {
  directory?: string | null
  project?: { worktree?: string | null }
}

const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
const scopedClientDirectories: string[] = []

let sessionUpdateResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let globalActiveSessions: Session[] = []
let globalArchivedSessions: Session[] = []
let globalUpsertCount = 0

// ---------------------------------------------------------------------------
// Mock SDK
// ---------------------------------------------------------------------------

const mockScopedClient = {}

const mockSdk = {
  session: {
    update: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.update", params })
      return Promise.resolve(sessionUpdateResult)
    }),
  },
}

// Mock opencodeClient
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/test/project",
    getSdkClient: () => mockSdk,
    updateSession: mock((sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
      replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      return Promise.resolve(sessionUpdateResult.data)
    }),
  },
}))

// Mock useConfigStore
mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
    }),
  },
}))

// Mock useSessionUIStore (provides getDirectoryForSession)
mock.module("../session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: (sessionId: string) => {
        if (sessionId === "ses_rename_1") return "/test/project"
        return null
      },
    }),
  },
}))

// Mock useInputStore
mock.module("../input-store", () => ({
  useInputStore: {
    getState: () => ({}),
  },
}))

// Mock useGlobalSessionsStore
mock.module("@/stores/useGlobalSessionsStore", () => ({
  mergeSessionDirectoryMetadata: (incoming: Session, existing: Session | null): Session => {
    if (!existing) return incoming
    const next = { ...incoming } as Session & { directory?: string | null; project?: { worktree?: string | null } | null }
    const existingRecord = existing as Session & { directory?: string | null; project?: { worktree?: string | null } | null }
    if (!next.directory && existingRecord.directory) next.directory = existingRecord.directory
    if (!next.project && existingRecord.project) next.project = existingRecord.project
    if (next.project && !next.project.worktree && existingRecord.project?.worktree) {
      next.project = { ...next.project, worktree: existingRecord.project.worktree }
    }
    return next
  },
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: globalActiveSessions,
      archivedSessions: globalArchivedSessions,
      upsertSession: (session: Session) => {
        globalUpsertCount++
        const existingIndex = globalActiveSessions.findIndex((s) => s.id === session.id)
        if (existingIndex >= 0) {
          const existingSig = getSig(globalActiveSessions[existingIndex])
          const newSig = getSig(session)
          if (existingSig !== newSig) {
            const next = [...globalActiveSessions]
            next[existingIndex] = session
            globalActiveSessions = next
          }
        } else {
          globalActiveSessions = [session, ...globalActiveSessions]
        }
      },
    }),
  },
}))

// ---------------------------------------------------------------------------
// Import the modules under test after mocks are set up
// ---------------------------------------------------------------------------

import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"
import { aggregateLiveSessions } from "../live-aggregate"

function getSig(s: Session): string {
  const directory = (s as Session & { directory?: string | null }).directory ?? ""
  const parentID = (s as Session & { parentID?: string | null }).parentID ?? ""
  return [
    s.id,
    s.title ?? "",
    s.time?.created ?? 0,
    s.time?.updated ?? 0,
    s.time?.archived ?? 0,
    directory,
    parentID,
    s.share?.url ?? "",
  ].join("|")
}

function createChildStore(initialSessions: Session[]): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    session: initialSessions,
    sessionTotal: initialSessions.length,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  const children = new Map(entries)
  return {
    children,
    ensureChild: (dir: string) => {
      const store = children.get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
    getChild: (dir: string) => children.get(dir),
  } as unknown as import("../child-store").ChildStoreManager
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Issue #2316 — session rename not visible until restart", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    sessionUpdateResult = {}
    globalActiveSessions = []
    globalArchivedSessions = []
    globalUpsertCount = 0
  })

  test("Scenario 1: Session in live child store — title propagates to store.aggregateLiveSessions", async () => {
    const oldSession = {
      id: "ses_rename_1",
      title: "Old Title",
      time: { created: 1, updated: 1 },
    } as Session

    const updatedSession = {
      id: "ses_rename_1",
      title: "New Title",
      time: { created: 1, updated: 2 },
    } as Session

    // Create a child store with the old session
    const sessionStore = createChildStore([oldSession])
    const childStores = createChildStores([["/test/project", sessionStore]])

    // Also put the session in the global store
    globalActiveSessions = [oldSession]

    // Set up the mock to return the updated session
    sessionUpdateResult = { data: updatedSession }

    // Import and set up session-actions
    const { setActionRefs, updateSessionTitle } = await import("../session-actions")
    const mockClient = mockSdk as unknown as OpencodeClient
    setActionRefs(mockClient, childStores, () => "/current/project")

    // Act: rename the session
    await updateSessionTitle("ses_rename_1", "New Title")

    // Assert 1: The live child store was updated
    const liveStoreSession = sessionStore.getState().session[0]
    expect(liveStoreSession.title).toBe("New Title")

    // Assert 2: upsertSession was called
    expect(globalUpsertCount).toBeGreaterThanOrEqual(1)

    // Assert 3: The global store was updated
    expect(globalActiveSessions[0]?.title).toBe("New Title")

    // Assert 3: aggregateLiveSessions returns the new title
    const liveStates = Array.from(childStores.children.values(), (store) => store.getState())
    const aggregated = aggregateLiveSessions(liveStates)
    const aggregatedSession = aggregated.find((s) => s.id === "ses_rename_1")
    expect(aggregatedSession?.title).toBe("New Title")
  })

  test("Scenario 2: Session only in global store (no live child store) — title propagates to globalActiveSessions", async () => {
    const updatedSession = {
      id: "ses_rename_1",
      title: "Renamed Session",
      time: { created: 5, updated: 10 },
    } as Session

    // Session is in global store but NOT in any live child store
    globalActiveSessions = [
      { id: "ses_rename_1", title: "Original Name", time: { created: 5, updated: 5 } } as Session,
    ]

    // Create an empty child store (session is not in it)
    const sessionStore = createChildStore([])
    const childStores = createChildStores([["/test/project", sessionStore]])

    sessionUpdateResult = { data: updatedSession }

    const { setActionRefs, updateSessionTitle } = await import("../session-actions")
    const mockClient = mockSdk as unknown as OpencodeClient
    setActionRefs(mockClient, childStores, () => "/current/project")

    await updateSessionTitle("ses_rename_1", "Renamed Session")

    // The global store should be updated
    expect(globalActiveSessions[0]?.title).toBe("Renamed Session")

    // Note: the live store may not be updated because the session isn't in it.
    // This is expected if the directory store hasn't bootstrapped yet.
    // The sidebar should still show the global store's version.
  })

  test("Scenario 3: Stale SSE event arrives after rename — new title survives", async () => {
    const oldSession = {
      id: "ses_rename_1",
      title: "Old Title",
      time: { created: 1, updated: 1 },
    } as Session

    const renamedSession = {
      id: "ses_rename_1",
      title: "Renamed Title",
      time: { created: 1, updated: 20 },
    } as Session

    const staleSSESession = {
      id: "ses_rename_1",
      title: "Old Title (stale SSE echo)",
      time: { created: 1, updated: 10 }, // older timestamp
    } as Session

    // Start with the renamed session (after the local rename)
    const sessionStore = createChildStore([renamedSession])
    const childStores = createChildStores([["/test/project", sessionStore]])
    globalActiveSessions = [renamedSession]

    // Simulate a stale SSE event arriving
    const { shouldSkipStaleSessionEvent } = await import("../session-event-freshness")
    const skipResult = shouldSkipStaleSessionEvent(
      renamedSession,
      staleSSESession,
    )
    expect(skipResult).toBe(true) // stale event should be skipped

    // The live store and global store should still have the new title
    expect(sessionStore.getState().session[0].title).toBe("Renamed Title")
    expect(globalActiveSessions[0]?.title).toBe("Renamed Title")
  })

  test("Scenario 4: mergeSessionDirectoryMetadata preserves title from incoming session", async () => {
    const { mergeSessionDirectoryMetadata } = await import("../../stores/useGlobalSessionsStore")

    const incoming = {
      id: "ses_1",
      title: "New Title",
      time: { created: 1, updated: 20 },
      directory: "/project",
    } as Session

    const existing: SessionWithDirectory = {
      id: "ses_1",
      title: "Old Title",
      time: { created: 1, updated: 10 },
      directory: "/project",
      project: { worktree: "/project" },
    } as unknown as SessionWithDirectory

    const merged = mergeSessionDirectoryMetadata(incoming, existing)

    // Title must come from the incoming (newer) session
    expect(merged.title).toBe("New Title")
    // Directory metadata should be preserved
    expect((merged as SessionWithDirectory).directory).toBe("/project")
  })

  test("Scenario 5: Live store session reference changes trigger Object.is inequality", async () => {
    const oldSession = {
      id: "ses_rename_1",
      title: "Original Title",
      time: { created: 1, updated: 1 },
    } as Session

    const sessionStore = createChildStore([oldSession])

    // Verify the initial reference
    const initialSession = sessionStore.getState().session[0]
    expect(initialSession.title).toBe("Original Title")

    // Simulate what updateLiveSession does
    const incoming = {
      id: "ses_rename_1",
      title: "Changed Title",
      time: { created: 1, updated: 5 },
    } as Session

    const current = sessionStore.getState().session
    const index = current.findIndex((item) => item.id === incoming.id)
    expect(index).toBe(0)

    const next = [...current]
    next[index] = incoming
    sessionStore.setState({ session: next })

    // After the update, the session reference should be different
    const updatedSession = sessionStore.getState().session[0]
    expect(updatedSession.title).toBe("Changed Title")
    expect(Object.is(initialSession, updatedSession)).toBe(false) // different reference

    // This means subscribeAllSelected's Object.is(selector(state), selector(previous))
    // will detect the change
  })

  test("Scenario 6: Full lifecycle — store updated, then sidebar selector reads new title", async () => {
    const oldSession = {
      id: "ses_rename_1",
      title: "Before Rename",
      time: { created: 1, updated: 1 },
      directory: "/test/project",
    } as Session & { directory: string }

    const updatedSession = {
      id: "ses_rename_1",
      title: "After Rename",
      time: { created: 1, updated: 2 },
      directory: "/test/project",
    } as Session & { directory: string }

    const sessionStore = createChildStore([oldSession])
    const childStores = createChildStores([["/test/project", sessionStore]])
    globalActiveSessions = [{ ...oldSession }]

    sessionUpdateResult = { data: updatedSession }

    const { setActionRefs, updateSessionTitle } = await import("../session-actions")
    const mockClient = mockSdk as unknown as OpencodeClient
    setActionRefs(mockClient, childStores, () => "/current/project")

    await updateSessionTitle("ses_rename_1", "After Rename")

    // Verify the live store has the new title
    expect(sessionStore.getState().session[0].title).toBe("After Rename")

    // Verify the global store has the new title
    expect(globalActiveSessions[0]?.title).toBe("After Rename")

    // Verify aggregateLiveSessions includes the new title
    const liveStates = Array.from(childStores.children.values(), (store) => store.getState())
    const aggregated = aggregateLiveSessions(liveStates)
    expect(aggregated.find((s) => s.id === "ses_rename_1")?.title).toBe("After Rename")
  })
})
