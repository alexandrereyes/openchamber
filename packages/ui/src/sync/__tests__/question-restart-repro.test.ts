/**
 * Reproduction test for issue #1955:
 * Questions asked before a restart do not render as an answerable form after restart.
 *
 * This test simulates the bootstrap flow after a restart to verify that
 * pending questions (especially those from subagent sessions) are properly
 * restored into the store and can be found by collectScopedBlockingRequests.
 */

import { describe, expect, test, mock } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}))

let mockListPendingQuestionsResult: QuestionRequest[] = []
const mockListPendingQuestionsShouldThrow = false

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/repo",
    getScopedSdkClient: () => ({}),
    setDirectory: () => undefined,
    listPendingQuestions: mock(async () => {
      if (mockListPendingQuestionsShouldThrow)
        throw new Error("question.list failed: simulated")
      return mockListPendingQuestionsResult
    }),
    listPendingPermissions: mock(async () => []),
    getSessionStatusForDirectory: mock(async () => ({})),
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({ isSessionAutoAccepting: () => false }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
    setState: () => undefined,
  },
}))

mock.module("@/stores/useTodosPersistStore", () => ({
  useTodosPersistStore: { getState: () => ({}) },
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import { resyncBlockingRequestsForDirectory } from "../sync-context"
import { collectScopedBlockingRequests } from "../scoped-blocking-requests"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildQuestion(
  overrides: Partial<QuestionRequest> = {},
): QuestionRequest {
  return {
    id: "que_1",
    sessionID: "ses_child",
    questions: [
      { question: "Continue?", header: "Q", options: [{ label: "Yes", description: "" }] },
    ],
    ...overrides,
  } as QuestionRequest
}

function createSession(id: string, parentID?: string): Session {
  return { id, parentID, title: id, time: { created: 1, updated: 1 }, version: "1" } as unknown as Session
}

function createDirectoryStore(initial: Partial<State> = {}): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Question restore after restart (issue #1955)", () => {
  const EMPTY: QuestionRequest[] = []

  // -----------------------------------------------------------------------
  // Bootstrap path: question.list() stores ALL questions regardless of
  // whether the session is known. This is the primary restore path.
  // -----------------------------------------------------------------------

  test("bootstrap stores questions even when sessions not yet loaded (Phase 2 before Phase 3)", () => {
    // Simulates: Phase 2 (question.list) completes before Phase 3 (loadSessions)
    const store = createDirectoryStore({ session: [] })

    // Bootstrap Phase 2: store questions regardless of known sessions
    const questions = [buildQuestion({ sessionID: "ses_child" })]
    const grouped: Record<string, QuestionRequest[]> = {}
    for (const q of questions) {
      if (!q?.id || !q.sessionID) continue
      const list = grouped[q.sessionID] ?? []
      list.push(q)
      grouped[q.sessionID] = list
    }
    const merged = { ...store.getState().question }
    for (const [sessionID, qs] of Object.entries(grouped)) {
      merged[sessionID] = qs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }
    store.setState({ question: merged })

    // Question stored even though child session is NOT in state.session
    expect(store.getState().question["ses_child"]?.length).toBeGreaterThan(0)
    expect(store.getState().question["ses_child"]).toHaveLength(1)

    // Phase 3 completes: sessions loaded
    store.setState({
      session: [createSession("ses_root"), createSession("ses_child", "ses_root")],
    })

    // Now collectScopedBlockingRequests CAN find the question
    const result = collectScopedBlockingRequests(
      store.getState().session,
      store.getState().question,
      "ses_root",
      EMPTY,
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("que_1")
  })

  test("bootstrap stores questions when sessions loaded first (Phase 3 before Phase 2)", () => {
    // Simulates: Phase 3 (loadSessions) completes before Phase 2 (question.list)
    const store = createDirectoryStore({ session: [] })

    // Phase 3 completes first
    store.setState({
      session: [createSession("ses_root"), createSession("ses_child", "ses_root")],
    })
    expect(collectScopedBlockingRequests(
      store.getState().session, store.getState().question, "ses_root", EMPTY,
    )).toBe(EMPTY)

    // Phase 2 completes
    const questions = [buildQuestion({ sessionID: "ses_child" })]
    const grouped: Record<string, QuestionRequest[]> = {}
    for (const q of questions) {
      if (!q?.id || !q.sessionID) continue
      const list = grouped[q.sessionID] ?? []
      list.push(q)
      grouped[q.sessionID] = list
    }
    const merged = { ...store.getState().question }
    for (const [sessionID, qs] of Object.entries(grouped)) {
      merged[sessionID] = qs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }
    store.setState({ question: merged })

    // Questions now findable
    const result = collectScopedBlockingRequests(
      store.getState().session, store.getState().question, "ses_root", EMPTY,
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("que_1")
  })

  test("deeply nested subagent questions are found when all sessions are loaded", () => {
    const store = createDirectoryStore({
      session: [
        createSession("ses_root"),
        createSession("ses_child", "ses_root"),
        createSession("ses_grandchild", "ses_child"),
      ],
    })

    // Bootstrap Phase 2
    store.setState({
      question: {
        ses_grandchild: [buildQuestion({ id: "que_gc", sessionID: "ses_grandchild" })],
      },
    })

    // Root can find grandchild question
    expect(collectScopedBlockingRequests(
      store.getState().session, store.getState().question, "ses_root", EMPTY,
    )).toHaveLength(1)

    // Child can find grandchild question
    expect(collectScopedBlockingRequests(
      store.getState().session, store.getState().question, "ses_child", EMPTY,
    )).toHaveLength(1)
  })

  // -----------------------------------------------------------------------
  // FAILURE MODE: child session missing from state.session
  // -----------------------------------------------------------------------

  test("FAILURE: question from missing child session is NOT found by collectScopedBlockingRequests", () => {
    // THE KEY REPRODUCTION OF THE BUG.
    //
    // Scenario: child session "ses_child" is NOT in state.session.
    // This can happen when:
    //   - session.list({limit:200}) fails silently (try/catch swallows error)
    //   - child session is beyond the first 200 results
    //   - child session was very recently created and didn't appear in the list
    //
    // In this case, even though the question IS stored in state.question,
    // collectScopedBlockingRequests cannot find it because computeSubtreeIds
    // doesn't know about "ses_child".

    const store = createDirectoryStore({
      session: [createSession("ses_root")],
    })

    // Bootstrap Phase 2 stores the question (it always does)
    store.setState({
      question: {
        ses_child: [buildQuestion({ sessionID: "ses_child" })],
      },
    })

    // Verify: question IS in the store
    expect(store.getState().question["ses_child"]?.length).toBeGreaterThan(0)
    expect(store.getState().question["ses_child"]).toHaveLength(1)

    // BUT: collectScopedBlockingRequests cannot find it
    const result = collectScopedBlockingRequests(
      store.getState().session,
      store.getState().question,
      "ses_root",
      EMPTY,
    )
    // This is the bug: result is EMPTY even though the question exists
    expect(result).toBe(EMPTY)
    expect(result).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // Resync path (reconnect, directory materialization)
  // -----------------------------------------------------------------------

  test("resync path filters out questions for unknown sessions (secondary bug)", async () => {
    // The resync path (resyncBlockingRequestsForDirectory) has an ADDITIONAL
    // filter: it drops questions for sessions NOT in the known session set.
    // This is called during reconnect/directory materialization.
    const store = createDirectoryStore({
      session: [createSession("ses_root")],
    })

    mockListPendingQuestionsResult = [
      buildQuestion({ sessionID: "ses_child" }),
    ]

    await resyncBlockingRequestsForDirectory("/repo", store)

    // Question for unknown session ses_child is silently dropped
    expect(store.getState().question["ses_child"]).toEqual(undefined)
  })

  test("resync path preserves questions for known sessions", async () => {
    const store = createDirectoryStore({
      session: [createSession("ses_root"), createSession("ses_child", "ses_root")],
    })

    mockListPendingQuestionsResult = [
      buildQuestion({ sessionID: "ses_child" }),
    ]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_child"]?.length).toBeGreaterThan(0)
    expect(store.getState().question["ses_child"]).toHaveLength(1)
  })
})
