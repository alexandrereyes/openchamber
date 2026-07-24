import type { Session } from '@opencode-ai/sdk/v2/client';

import { computeSubtreeIds } from '@/sync/scoped-blocking-requests';

export const collectActiveSessionSubtreeIds = (sessions: Session[], rootId: string): string[] => {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));

  return Array.from(computeSubtreeIds(sessions, rootId)).filter((id) => {
    const session = sessionsById.get(id);
    return Boolean(session && !session.time?.archived);
  });
};
