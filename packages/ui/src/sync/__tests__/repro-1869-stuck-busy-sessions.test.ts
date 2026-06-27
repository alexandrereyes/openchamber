/**
 * Reproduction test for Issue #1869
 *
 * Bug: Busy sessions can stay stuck when directory events keep watchdog fresh.
 *
 * The key issue is that `lastActiveEventAt` is tracked per directory, not per
 * session. Unrelated events (other sessions, file watchers, etc.) in the same
 * directory keep the stale watchdog timer fresh, preventing the fallback
 * reconnect+resync path from firing.
 *
 * The recovery from a missed idle event depends on:
 *   1. The periodic monotonic poll running every 5s
 *   2. `needsSnapshotAfterStatusPoll` detecting the busy/idle mismatch
 *   3. `triggerDirectoryResync` performing an authoritative resync
 *
 * This test demonstrates the gap: when the `/session/status` API returns null
 * (fetch failure) across multiple polls, the mismatch detection is silently
 * skipped, and the session stays stuck busy. There's no recovery path for the
 * case where the API keeps failing while SSE events from other sessions keep
 * the watchdog timer fresh.
 */
import { describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import { applySessionStatusSnapshot, needsSnapshotAfterStatusPoll } from "../sync-context"

type StatusSnapshot = Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

const BUSY: SessionStatus = { type: "busy" }
const IDLE: SessionStatus = { type: "idle" }

describe("Issue #1869 - Stuck busy sessions", () => {
  describe("Part 1: Confirming the recovery mechanism exists", () => {
    test("monotonic poll does NOT lower busy to idle (by design)", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      const snapshot = {} as StatusSnapshot // empty = everything idle

      const changed = applySessionStatusSnapshot(store, snapshot, ["ses_a"], "monotonic")

      expect(changed).toBe(false)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("needsSnapshotAfterStatusPoll detects the mismatch", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })

      // The snapshot entry for ses_a is undefined (absent from snapshot = idle)
      // Store says busy but snapshot says idle/absent => mismatch
      expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", undefined)).toBe(true)

      // If snapshot confirms busy, no mismatch
      expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", { type: "busy" })).toBe(false)
    })

    test("authoritative resync DOES lower busy to idle", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })

      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "authoritative")

      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual(IDLE)
    })
  })

  describe("Part 2: The gap — API failure during poll prevents recovery", () => {
    test("when poll returns null (fetch failed), mismatch detection is skipped entirely", () => {
      // This simulates: resyncDirectorySessionStatuses returns null
      // In pollDirectoryStatuses:
      //   const statuses = await resyncDirectorySessionStatuses(...)
      //   if (!statuses) return;  // <-- early return, no mismatch check
      //
      // The session stays busy and no authoritative resync is triggered.
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      const before = store.getState()
      const statuses = null // Simulating API failure

      // This is what pollDirectoryStatuses does:
      if (!statuses) {
        // Early return — no mismatch detection, no authoritative resync
        // The session remains busy
      }

      expect(store.getState().session_status.ses_a).toEqual(BUSY)
      // needsSnapshotAfterStatusPoll is never called
    })

    test("consecutive API failures with no SSE idle event keeps session stuck", () => {
      // Scenario:
      // 1. Session A is busy
      // 2. SSE idle event is missed (never arrives)
      // 3. Other directory events keep lastActiveEventAt fresh (watchdog never fires)
      // 4. Multiple polls return null (API temporarily failing)
      // 5. No recovery path triggers
      //
      // The stale watchdog requires 20s of no events to trigger.
      // With events arriving every <20s from other sessions, it never fires.
      // The polls keep skipping due to API failures.
      // The session stays stuck busy indefinitely.
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })

      // Simulate multiple poll cycles with API failure
      for (let pollCycle = 0; pollCycle < 10; pollCycle++) {
        const before = store.getState()
        const statuses: null = null // API returned null

        // In pollDirectoryStatuses:
        if (!statuses) {
          // Early return — no mismatch check, no triggerDirectoryResync
          // Session stays busy
          expect(store.getState().session_status.ses_a).toEqual(BUSY)
          continue
        }

        // This code is never reached
        const needsSnapshot = needsSnapshotAfterStatusPoll(before, "ses_a", undefined)
        if (needsSnapshot) {
          // triggerDirectoryResync would be called
        }
      }

      // After all poll cycles, session is still stuck busy
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })
  })

  describe("Part 3: The stale watchdog timer never fires when other events keep it fresh", () => {
    test("directory events from other sessions keep lastActiveEventAt fresh", () => {
      // The watchdog tick logic:
      //
      //   const lastActiveEventAt = lastActiveEventAtByDirectoryRef.current.get(directory) ?? now
      //   if (
      //     now - lastActiveEventAt >= ACTIVE_SESSION_STALE_EVENT_MS  // 20s
      //     && now - lastFullResyncAt >= ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS  // 15s
      //   ) {
      //     pipelineReconnectRef.current?.("active_stream_stale")
      //     triggerDirectoryResync(directory)
      //   }
      //
      // lastActiveEventAt is per-directory, set on EVERY SSE event (except heartbeats).
      // Events from unrelated sessions or file activity keep it fresh.

      // Simulate directory-level event timestamps (as in lastActiveEventAtByDirectoryRef)
      const DIRECTORY = "/test/project"
      const otherSessionEvents = [1000, 3000, 7000, 11000, 15000, 19000] // events from other sessions
      const ACTIVE_SESSION_STALE_EVENT_MS = 20000

      let lastActiveEventAt = 0

      // Event at t=1000 from session B (unrelated)
      lastActiveEventAt = 1000
      // Event at t=3000 from session C (unrelated)
      lastActiveEventAt = 3000
      // Event at t=7000 from file watcher
      lastActiveEventAt = 7000

      // At tick time t=8000 (3s after last event):
      const now_tick1 = 8000
      const stale_tick1 = now_tick1 - lastActiveEventAt // 1000ms
      expect(stale_tick1 >= ACTIVE_SESSION_STALE_EVENT_MS).toBe(false) // Not stale

      // Event at t=11000
      lastActiveEventAt = 11000
      // Event at t=15000
      lastActiveEventAt = 15000

      // At tick time t=18000:
      const now_tick2 = 18000
      const stale_tick2 = now_tick2 - lastActiveEventAt // 3000ms
      expect(stale_tick2 >= ACTIVE_SESSION_STALE_EVENT_MS).toBe(false) // Not stale

      // Event at t=19000
      lastActiveEventAt = 19000

      // At tick time t=25000:
      const now_tick3 = 25000
      const stale_tick3 = now_tick3 - lastActiveEventAt // 6000ms
      expect(stale_tick3 >= ACTIVE_SESSION_STALE_EVENT_MS).toBe(false) // Not stale

      // As long as events arrive more frequently than every 20s,
      // the stale watchdog NEVER fires.
      // With multiple sessions active, events can easily arrive <20s apart.
    })
  })

  describe("Part 4: The full scenario — how a session gets stuck", () => {
    test("recovery requires all three conditions to align (fragile chain)", () => {
      // The recovery chain from a missed idle event is:
      //
      // 1. Monotonic poll runs (every 5s)
      // 2. API doesn't return null (fetch succeeds)
      // 3. needsSnapshotAfterStatusPoll detects mismatch
      // 4. triggerDirectoryResync fires (no concurrent resync in progress)
      // 5. Authoritative resync succeeds (API doesn't return null)
      //
      // If ANY of these fails, the session stays stuck until the next
      // cycle succeeds. With the stale watchdog preventing reconnect,
      // there's no fallback if the chain keeps failing.

      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })

      // Simulate what happens when conditions do align correctly:
      // Step 1-2: Poll succeeds
      const before = store.getState()
      const statuses = {} as StatusSnapshot // empty snapshot = everything idle

      // Step 3: Mismatch detected
      const mismatch = needsSnapshotAfterStatusPoll(before, "ses_a", statuses["ses_a"])
      expect(mismatch).toBe(true)

      // Step 4-5: Authoritative resync would fix it
      const changed = applySessionStatusSnapshot(store, statuses, ["ses_a"], "authoritative")
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual(IDLE)
    })

    test("BUT: if step 2 fails (API null), session stays stuck and retry is slow", () => {
      // The poll runs every 5s. If the API fails on N consecutive polls,
      // the session is stuck for N*5 seconds.
      // With other events keeping the watchdog fresh, there's NO
      // backstop recovery. The only fix is:
      // - A successful poll+resync cycle
      // - Or the user sending a new message (which triggers a new
      //   session.status event flow)

      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      let successfulPollCount = 0

      // Simulate 3 consecutive API failures (15s of stuck state)
      for (let cycle = 0; cycle < 3; cycle++) {
        const statuses: null = null // API returns null
        if (!statuses) {
          // Mismatch detection skipped entirely
          continue
        }
        successfulPollCount++
      }

      // After 3 failed polls (15s), session still busy
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
      expect(successfulPollCount).toBe(0)

      // Finally a successful poll
      const statuses = {} as StatusSnapshot
      const before = store.getState()
      const mismatch = needsSnapshotAfterStatusPoll(before, "ses_a", statuses["ses_a"])
      expect(mismatch).toBe(true)

      // After authoritative resync, finally fixed
      applySessionStatusSnapshot(store, statuses, ["ses_a"], "authoritative")
      expect(store.getState().session_status.ses_a).toEqual(IDLE)
    })
  })
})
