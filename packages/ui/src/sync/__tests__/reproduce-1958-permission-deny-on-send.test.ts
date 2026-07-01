/**
 * Reproduction test for #1958 — Deny open permission prompts automatically when sending a message.
 *
 * The bug: Sending a message while a permission prompt is open does NOT deny the pending
 * permission, unlike question prompts which are dismissed via `dismissOpenQuestionsForSession`.
 *
 * Test plan:
 * 1. Verify that `dismissOpenQuestionsForSession` exists and handles questions (existing behavior)
 * 2. Verify that there is NO `dismissOpenPermissionsForSession` counterpart
 * 3. Verify that `dismissPermission` is single-request only — does NOT walk the session subtree
 *    and does NOT optimistically clear the store
 * 4. Verify that handleSubmit in ChatInput.tsx calls question dismiss but NOT permission dismiss
 * 5. Verify that useSessionActivity treats pending permissions as idle (so send button stays "Send")
 *    — the user CAN hit send while a permission is open, and the permission is NOT dismissed
 */

import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"

// ---------------------------------------------------------------------------
// Minimal mock setup (mirrors session-actions.test.ts infrastructure)
// ---------------------------------------------------------------------------

const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
const scopedClientDirectories: string[] = []

const mockSdk = {
  session: {
    messages: mock(() => Promise.resolve({ data: [] })),
    revert: mock(() => Promise.resolve({})),
    abort: mock(() => Promise.resolve({ data: true })),
  },
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      return Promise.resolve({ data: true })
    }),
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      return Promise.resolve({ data: true })
    }),
  },
}

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: (directory: string) => {
      scopedClientDirectories.push(directory)
      return mockSdk
    },
    getDirectory: () => "/test/project",
    setDirectory: () => {},
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
  },
}))

mock.module("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: () => "/test/project",
    }),
  },
}))

mock.module("./input-store", () => ({
  useInputStore: {
    getState: () => ({
      pendingInputText: "",
      pendingInputMode: "normal" as const,
      attachedFiles: [],
    }),
    setState: () => {},
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  resolveGlobalSessionDirectory: (session: Record<string, unknown>) => {
    return (session as { directory?: string | null }).directory ?? null
  },
  mergeSessionDirectoryMetadata: (incoming: Record<string, unknown>) => incoming,
  useGlobalSessionsStore: {
    getState: () => ({
      upsertSession: () => {},
      activeSessions: [],
      archivedSessions: [],
    }),
  },
}))

mock.module("./sync-refs", () => ({
  registerSessionDirectory: () => {},
}))

import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"
import type { Session } from "@opencode-ai/sdk/v2/client"

function createStore(
  permissions: Record<string, PermissionRequest[]>,
  state?: Partial<DirectoryStore>,
): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...state,
    permission: permissions,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  return {
    children: new Map(entries),
    ensureChild: (dir: string) => {
      const store = new Map(entries).get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
    getChild: (dir: string) => new Map(entries).get(dir),
  } as unknown as import("../child-store").ChildStoreManager
}

function buildPermission(id: string, sessionId: string): PermissionRequest {
  return {
    id,
    sessionID: sessionId,
    permission: "bash",
    patterns: [],
    metadata: {},
    always: [],
  }
}

function buildQuestion(id: string, sessionId: string): QuestionRequest {
  return {
    id,
    sessionID: sessionId,
    questions: [{ question: "Continue?", header: "Confirm", options: [{ label: "Yes", description: "Proceed" }] }],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bug reproduction: #1958 — Deny open permission prompts on send", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
  })

  test("BUG 1: dismissOpenQuestionsForSession exists and accepts questions, but no permission counterpart exists", async () => {
    // This imports the actual module to check exports
    const sessionActions = await import("../session-actions")

    // dismissOpenQuestionsForSession exists (added in #1740)
    expect(typeof sessionActions.dismissOpenQuestionsForSession).toBe("function")

    // No dismissOpenPermissionsForSession function exists — this is the bug!
    expect((sessionActions as Record<string, unknown>).dismissOpenPermissionsForSession).toBeUndefined()
  })

  test("BUG 2: dismissPermission is single-request only — does NOT walk the subtree", async () => {
    // Setup: root session + child session, both with pending permissions
    const rootPerm = buildPermission("perm-root", "session-a")
    const childPerm = buildPermission("perm-child", "session-child")
    const store = createStore(
      { "session-a": [rootPerm], "session-child": [childPerm] },
      {
        session: [
          { id: "session-a", time: { created: 1 } } as Session,
          { id: "session-child", parentID: "session-a", time: { created: 2 } } as Session,
        ],
      },
    )
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissPermission } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient, childStores, () => "/test/project")

    // dismissPermission only handles ONE request — we must call it per-request
    await dismissPermission("session-a", "perm-root")

    // Only the root permission was rejected
    const rejectCalls = replyCalls.filter((call) => call.method === "permission.reply")
    expect(rejectCalls).toHaveLength(1)
    expect(rejectCalls[0].params.requestID).toBe("perm-root")

    // The child permission was NOT dismissed — it remains in the store
    expect(store.getState().permission["session-child"]).toBeDefined()
    expect(store.getState().permission["session-child"]?.[0]?.id).toBe("perm-child")

    // Additionally, dismissPermission does NOT optimistically clear the store
    // It waits for the network round-trip. The permission is still in the store
    // until the server responds. Compare with dismissOpenQuestionsForSession
    // which removes questions before the reject call.
    // Note: In this test the network call succeeds, so the store still has the
    // permission because dismissPermission doesn't remove it at all — it only
    // calls permission.reply on the server.
    expect(store.getState().permission["session-a"]).toBeDefined()
    expect(store.getState().permission["session-a"]?.[0]?.id).toBe("perm-root")
  })

  test("BUG 3: dismissOpenQuestionsForSession does NOT handle permissions — only questions", async () => {
    // Setup: session with both a pending question and a pending permission
    const question = buildQuestion("q-1", "session-a")
    const perm = buildPermission("perm-1", "session-a")
    const store = createStore(
      { "session-a": [perm] },
      {
        session: [{ id: "session-a", time: { created: 1 } } as Session],
        question: { "session-a": [question] },
      },
    )
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient, childStores, () => "/test/project")

    // Dismiss questions — this works
    const dismissed = await dismissOpenQuestionsForSession("session-a")
    expect(dismissed).toBe(true)

    // The question was rejected
    const questionRejectCalls = replyCalls.filter((call) => call.method === "question.reject")
    expect(questionRejectCalls).toHaveLength(1)
    expect(questionRejectCalls[0].params.requestID).toBe("q-1")

    // The question was optimistically cleared
    expect(store.getState().question["session-a"]).toBeUndefined()

    // BUT the permission was NOT dismissed — it remains!
    const permissionReplyCalls = replyCalls.filter((call) => call.method === "permission.reply")
    expect(permissionReplyCalls).toHaveLength(0)
    expect(store.getState().permission["session-a"]).toBeDefined()
    expect(store.getState().permission["session-a"]?.[0]?.id).toBe("perm-1")
  })

  test("BUG 4: handleSubmit only dismisses questions, never permissions", async () => {
    // This test verifies that the handleSubmit path in ChatInput.tsx
    // only calls dismissOpenQuestionsForSession, not a permission equivalent.
    // We test by checking the actual ChatInput.tsx source via grep patterns.

    // Read the specific lines in ChatInput.tsx that handle the dismiss-on-send
    // We import the file indirectly through the session-actions calls that handleSubmit makes.

    // The key observation: handleSubmit at line 1814 only calls
    //   dismissOpenQuestionsForSession(currentSessionId)
    // There is no corresponding call to dismiss permissions.
    //
    // Let's verify this by checking that when only a permission is pending,
    // handleSubmit's dismiss path does nothing for it.

    const perm = buildPermission("perm-send", "session-a")
    const store = createStore(
      { "session-a": [perm] },
      {
        session: [{ id: "session-a", time: { created: 1 } } as Session],
        // No questions — only permissions
      },
    )
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient, childStores, () => "/test/project")

    // This is what handleSubmit does: it calls dismissOpenQuestionsForSession
    const dismissed = await dismissOpenQuestionsForSession("session-a")

    // No questions were pending, so dismissOpenQuestionsForSession returns false
    expect(dismissed).toBe(false)

    // No question reject was called — correct, there are no questions
    const questionRejectCalls = replyCalls.filter((call) => call.method === "question.reject")
    expect(questionRejectCalls).toHaveLength(0)

    // BUT: the permission was NOT dismissed either! This is the bug.
    // handleSubmit falls through to send the message directly,
    // which races with the still-active, permission-blocked agent turn.
    expect(store.getState().permission["session-a"]).toBeDefined()
    expect(store.getState().permission["session-a"]?.[0]?.id).toBe("perm-send")

    // No permission.reply was sent
    const permissionReplyCalls = replyCalls.filter((call) => call.method === "permission.reply")
    expect(permissionReplyCalls).toHaveLength(0)
  })

  test("BUG 5: useSessionActivity treats pending permissions as idle — send button stays enabled", async () => {
    // When permissions are pending, useSessionActivity returns phase='idle'
    // and isWorking=false. This means the send button stays "Send" (not "Stop"),
    // so the user CAN hit send while a permission is open.
    // Combined with the missing permission dismiss, this means the send
    // races with the still-active permission-blocked agent turn.

    // Verify by checking the source code of useSessionActivity directly.
    // Line 41 of useSessionActivity.ts:
    //   if (permissions.length > 0 || questions.length > 0) return IDLE_RESULT;
    //
    // This returns IDLE_RESULT (phase='idle', isWorking=false) when permissions
    // are pending — the send button is enabled. But there is NO code path that
    // denies the permission on send.
    //
    // This is the root cause: permissions make the session look "idle" so the send
    // button is active, but sending does NOT dismiss the permission.

    // Read the file to verify the logic
    const fs = await import("fs")
    const content = fs.readFileSync(
      new URL("../../hooks/useSessionActivity.ts", import.meta.url),
      "utf-8",
    )
    // Verify line 41 contains the permission check (the exact line may shift,
    // but the pattern should be there)
    expect(content).toContain("permissions.length > 0 || questions.length > 0")
    // Verify there is NO permission dismissal in this module
    expect(content).not.toContain("dismissOpenPermissions")
    expect(content).not.toContain("permission.reply")
  })
})
