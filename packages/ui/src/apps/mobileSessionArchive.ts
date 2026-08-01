import type { Session } from '@opencode-ai/sdk/v2/client';

import { computeSubtreeIds } from '@/sync/scoped-blocking-requests';

type ArchiveStateListener = () => void;

let archiveInFlight = false;
const archiveStateListeners = new Set<ArchiveStateListener>();

export const subscribeMobileSessionArchive = (listener: ArchiveStateListener): (() => void) => {
  archiveStateListeners.add(listener);
  return () => archiveStateListeners.delete(listener);
};

export const getMobileSessionArchiveInFlight = (): boolean => archiveInFlight;

export const beginMobileSessionArchive = (): boolean => {
  if (archiveInFlight) return false;
  archiveInFlight = true;
  archiveStateListeners.forEach((listener) => listener());
  return true;
};

export const endMobileSessionArchive = (): void => {
  if (!archiveInFlight) return;
  archiveInFlight = false;
  archiveStateListeners.forEach((listener) => listener());
};

export const collectActiveSessionSubtreeIds = (sessions: Session[], rootId: string): string[] => {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));

  return Array.from(computeSubtreeIds(sessions, rootId)).filter((id) => {
    const session = sessionsById.get(id);
    return Boolean(session && !session.time?.archived);
  });
};
