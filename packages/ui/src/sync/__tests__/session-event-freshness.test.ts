import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"

import { shouldSkipStaleSessionEvent } from "../session-event-freshness"

const buildSession = (title: string, time: Partial<NonNullable<Session["time"]>>): Session => ({
  id: "ses_1",
  title,
  time: time as Session["time"],
} as Session)

describe("shouldSkipStaleSessionEvent", () => {
  test("skips a stale SSE session update after a newer local rename", () => {
    const current = buildSession("New Title", { created: 1, updated: 20 })
    const incoming = buildSession("Old Title", { created: 1, updated: 10 })

    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(true)
  })

  test("allows a fresher SSE update to apply", () => {
    const current = buildSession("Old Title", { created: 1, updated: 10 })
    const incoming = buildSession("New Title", { created: 1, updated: 20 })

    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(false)
  })

  test("falls back to created timestamp when updated is missing", () => {
    const current = buildSession("Current", { created: 20 })
    const incoming = buildSession("Incoming", { created: 10 })

    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Bug reproduction: issue #2204
  // When the server doesn't bump time.updated on rename, incoming SSE events
  // carry the old title with the SAME timestamp. shouldSkipStaleSessionEvent
  // uses strict less-than (incoming < current), so equal timestamps return
  // false — the stale event is NOT skipped and overwrites the renamed title.
  // ---------------------------------------------------------------------------

  test("BUG: should skip stale SSE when timestamps are equal (server didn't bump time.updated on rename)", () => {
    // Current store already has the renamed session (new title, timestamp T)
    const current = buildSession("User Renamed Title", { created: 1, updated: 100 })
    // SSE event arrives carrying the OLD title with the SAME timestamp T
    const incoming = buildSession("Old Auto-Generated Title", { created: 1, updated: 100 })

    // BUG: strict less-than returns false because 100 < 100 is false
    // Expected: true (skip the stale event — current is the user's rename)
    // Actual: false (stale event is applied, overwriting the new title)
    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(true)
  })

  test("BUG: should skip stale when both have no updated and equal created timestamps", () => {
    // When neither session has an updated timestamp but both share the same
    // created timestamp, we can't distinguish freshness either.
    const current = buildSession("Renamed Title", { created: 42 })
    const incoming = buildSession("Old Title", { created: 42 })

    // This could silently lose the rename just like the equal-updated case.
    // The current behavior returns false (no skip), which may be wrong.
    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(true)
  })
})
