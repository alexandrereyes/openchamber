/**
 * Reproduction test for issue #2291: "Failed to create session"
 *
 * This test reproduces the "Failed to create session" error path that happens
 * when the OpenCode backend is unavailable or returns an error.
 *
 * Root cause analysis:
 * - createSessionAction() in session-actions.ts catches SDK errors and returns null
 * - store.createSession() checks for null/undefined and returns null
 * - materializeOpenDraftSession() checks for falsy session and throws "Failed to create session"
 * - The error propagates to ChatInput.tsx which displays it as an error toast
 *
 * All these symptoms are consistent with the OpenCode backend being unreachable,
 * returning errors, or running an incompatible version:
 * - Session creation fails → cannot reach /session API endpoint
 * - Models fail to load → cannot reach /config endpoint via getProvidersForConfig()
 * - API key saving fails → cannot reach /auth/set endpoint
 * - Disconnect fails → cannot reach the provider disconnect endpoint
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"

// Recorded call info
const setCurrentSessionCalls: Array<{ id: string | null; directoryHint: string | null | undefined }> = []
const registerSessionDirectoryCalls: Array<{ sessionID: string; directory: string }> = []
const upsertSessionCalls: Session[] = []
const markSessionAsOpenChamberCreatedCalls: string[] = []

// Configurable opencodeClient.createSession
let nextCreateSessionResponse: Session = { id: "ses_default", time: { created: 1 } } as Session
let nextCreateSessionCalls: Array<{ params: unknown; directory: string | null | undefined }> = []
let createSessionShouldThrow = false
let createSessionError: Error = new Error("Server error")

// Configurable current directory
let currentDirectory: string | null = null

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => currentDirectory,
    setDirectory: mock(() => undefined),
    createSession: mock(async (params: unknown, directory?: string | null) => {
      nextCreateSessionCalls.push({ params, directory })
      if (createSessionShouldThrow) {
        throw createSessionError
      }
      return nextCreateSessionResponse
    }),
  },
}))

mock.module("../session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      setCurrentSession: (id: string | null, directoryHint?: string | null) => {
        setCurrentSessionCalls.push({ id, directoryHint })
      },
      markSessionAsOpenChamberCreated: (sessionId: string) => {
        markSessionAsOpenChamberCreatedCalls.push(sessionId)
      },
    }),
  },
}))

mock.module("../sync-refs", () => ({
  registerSessionDirectory: (sessionID: string, directory: string) => {
    registerSessionDirectoryCalls.push({ sessionID, directory })
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      upsertSession: (session: Session) => {
        upsertSessionCalls.push(session)
      },
    }),
  },
  mergeSessionDirectoryMetadata: (incoming: Session) => incoming,
  mergeLiveSessionWithGlobalSession: (incoming: Session) => incoming,
  resolveGlobalSessionDirectory: () => null,
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
    }),
  },
}))

mock.module("../input-store", () => ({
  useInputStore: {
    getState: () => ({
      clearAttachedFiles: () => undefined,
      addRestoredAttachment: () => undefined,
    }),
  },
}))

const { createSession } = await import("../session-actions")

beforeEach(() => {
  setCurrentSessionCalls.length = 0
  registerSessionDirectoryCalls.length = 0
  upsertSessionCalls.length = 0
  markSessionAsOpenChamberCreatedCalls.length = 0
  nextCreateSessionCalls = []
  nextCreateSessionResponse = { id: "ses_default", time: { created: 1 } } as Session
  currentDirectory = null
  createSessionShouldThrow = false
  createSessionError = new Error("Server error")
})

describe("issue #2291 — Failed to create session", () => {
  test("reproduces failure when SDK throws (network error)", async () => {
    createSessionShouldThrow = true
    createSessionError = new Error("Network error: failed to fetch")

    const result = await createSession("test title", "/projects/test", null)

    // createSessionAction catches the error and returns null
    expect(result).toBeNull()
    // The SDK was called
    expect(nextCreateSessionCalls).toHaveLength(1)
    // No side effects happen on failure
    expect(setCurrentSessionCalls).toHaveLength(0)
    expect(registerSessionDirectoryCalls).toHaveLength(0)
    expect(upsertSessionCalls).toHaveLength(0)
  })

  test("reproduces failure when SDK returns HTML (server version mismatch)", async () => {
    // When the server responds with text/html (e.g. old server or nginx proxy),
    // the SDK interceptor throws this specific error
    createSessionShouldThrow = true
    createSessionError = new Error("Request is not supported by this version of OpenCode Server (Server responded with text/html)")

    const result = await createSession("test title", null, null)

    expect(result).toBeNull()
    expect(setCurrentSessionCalls).toHaveLength(0)
    expect(registerSessionDirectoryCalls).toHaveLength(0)
  })

  test("reproduces failure when SDK throws 500 Internal Server Error", async () => {
    createSessionShouldThrow = true
    createSessionError = new Error("session.create failed (500): Internal server error")

    const result = await createSession("test title", "/projects/test", null)

    expect(result).toBeNull()
  })
})
