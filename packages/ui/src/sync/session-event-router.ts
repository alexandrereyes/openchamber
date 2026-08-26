import type { Event, Session } from "@opencode-ai/sdk/v2/client"
import {
  isGlobalSessionRecencyOnlyUpdate,
  mergeSessionDirectoryMetadata,
  useGlobalSessionsStore,
  type GlobalSessionMutation,
} from "@/stores/useGlobalSessionsStore"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import { streamPerfCount, streamPerfMark } from "@/stores/utils/streamDebug"
import { stripSessionDiffSnapshots } from "./sanitize"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"
import { isOpenChamberInternalSessionEvent } from "@/lib/sessionInternalMetadata"

const pendingGlobalSessionUpdates = new Map<string, { runtimeKey: string; session: Session }>()

const clearPendingGlobalSessionUpdates = (): void => {
  pendingGlobalSessionUpdates.clear()
}

const scheduleGlobalSessionUpdate = (session: Session): void => {
  pendingGlobalSessionUpdates.set(session.id, { runtimeKey: getRuntimeKey(), session })
  streamPerfCount("ui.global_sessions.event_update_deferred")
}

subscribeRuntimeEndpointWillChange(clearPendingGlobalSessionUpdates)

const getSessionInfoFromPayload = (event: Event): Session | null => {
  if (event.type !== "session.created" && event.type !== "session.updated" && event.type !== "session.deleted") {
    return null
  }

  // SAFETY: OpenCode session lifecycle events own a properties object; this
  // narrow view reads only their shared info field before validating it.
  const properties = (event as { properties?: { info?: Partial<Session> } }).properties
  if (!properties) {
    return null
  }

  const info = properties.info
  if (!info) {
    return null
  }

  if (info.id?.constructor !== String || !info.time) {
    return null
  }

  // SAFETY: id and time are the required Session fields consumed by this
  // boundary; the SDK event contract supplies the remaining session fields.
  return stripSessionDiffSnapshots(info as Session)
}

export const applySessionEventsToGlobalSessions = (
  payloads: readonly Event[],
  internalSessionGeneration?: number,
): void => {
  if (payloads.length === 0) return
  const runtimeKey = getRuntimeKey()
  const store = useGlobalSessionsStore.getState()
  const overlay = new Map(store.entityById)
  const mutations: GlobalSessionMutation[] = []
  let flushedRecency = false

  const appendUpsert = (session: Session): void => {
    const existing = overlay.get(session.id) ?? null
    const merged = mergeSessionDirectoryMetadata(session, existing)
    overlay.set(session.id, merged)
    mutations.push({ type: "upsert", session: merged })
  }

  for (const payload of payloads) {
    if (isOpenChamberInternalSessionEvent(payload, internalSessionGeneration)) continue

    if (payload.type === "session.idle" || payload.type === "session.error") {
      const sessionID = (payload as { properties?: { sessionID?: unknown } }).properties?.sessionID
      if (typeof sessionID !== "string") continue
      const update = pendingGlobalSessionUpdates.get(sessionID)
      pendingGlobalSessionUpdates.delete(sessionID)
      if (!update || update.runtimeKey !== runtimeKey) continue
      const currentSession = overlay.get(sessionID) ?? null
      if (
        !currentSession
        || shouldSkipStaleSessionEvent(currentSession, update.session)
        || !isGlobalSessionRecencyOnlyUpdate(currentSession, update.session)
      ) continue
      appendUpsert(update.session)
      flushedRecency = true
      continue
    }

    if (payload.type === "session.created") {
      const session = getSessionInfoFromPayload(payload)
      if (session) {
        const currentSession = overlay.get(session.id) ?? null
        if (!shouldSkipStaleSessionEvent(currentSession, session)) appendUpsert(session)
      }
      continue
    }

    if (payload.type === "session.updated") {
      const session = getSessionInfoFromPayload(payload)
      if (session) {
        const currentSession = overlay.get(session.id) ?? null
        if (!shouldSkipStaleSessionEvent(currentSession, session)) {
          if (currentSession && isGlobalSessionRecencyOnlyUpdate(currentSession, session)) {
            scheduleGlobalSessionUpdate(session)
          } else {
            pendingGlobalSessionUpdates.delete(session.id)
            appendUpsert(session)
            streamPerfCount("ui.global_sessions.event_update_immediate")
          }
        }
      }
      continue
    }

    if (payload.type === "session.deleted") {
      const sessionID = (payload as { properties?: { sessionID?: string } }).properties?.sessionID
        ?? getSessionInfoFromPayload(payload)?.id
      if (sessionID) {
        pendingGlobalSessionUpdates.delete(sessionID)
        overlay.delete(sessionID)
        mutations.push({ type: "remove", sessionId: sessionID })
      }
    }
  }

  if (mutations.length === 0 || runtimeKey !== getRuntimeKey()) return
  if (flushedRecency) streamPerfMark("global_sessions.event_update_flush")
  store.applySessionMutations(mutations)
  streamPerfCount("ui.global_sessions.event_update_publication")
}

export const applySessionEventToGlobalSessions = (payload: Event, internalSessionGeneration?: number): void => {
  applySessionEventsToGlobalSessions([payload], internalSessionGeneration)
}
