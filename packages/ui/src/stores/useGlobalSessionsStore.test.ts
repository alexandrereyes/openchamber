import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  combineActiveSessionsWithLive,
  isGlobalSessionRecencyOnlyUpdate,
  resolveGlobalSessionDirectory,
  mergeLiveSessionWithGlobalSession,
  useGlobalSessionsStore,
} from './useGlobalSessionsStore';

type SessionExtra = Partial<Session> & {
  directory?: string | null;
  project?: { worktree?: string | null } | null;
};

const buildSession = (shareUrl: string, extra: SessionExtra = {}): Session => ({
  id: 'ses_1',
  title: 'Shared session',
  time: { created: 1, updated: 2 },
  share: { url: shareUrl },
  ...extra,
} as Session);

describe('useGlobalSessionsStore', () => {
  beforeEach(() => {
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      hasLoaded: false,
      status: 'idle',
    });
  });

  test('updates an existing session when the share URL changes', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a'));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b'));

    expect(useGlobalSessionsStore.getState().activeSessions[0]?.share?.url).toBe('https://share.example/b');
  });

  test('preserves directory metadata when a live update omits it', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      time: { created: 1, updated: 3 },
    }));

    const session = useGlobalSessionsStore.getState().activeSessions[0];
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/app');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.[0]?.id).toBe('ses_1');
  });

  test('preserves raw directory metadata when a live update only has project worktree', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      project: { worktree: '/repo/app' },
      time: { created: 1, updated: 3 },
    }));

    const session = useGlobalSessionsStore.getState().activeSessions[0] as Session & { directory?: string | null };
    expect(session.directory).toBe('/repo/app');
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/app');
  });

  test('trusts explicit incoming raw directory metadata', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      directory: '/repo/app-worktree',
      time: { created: 1, updated: 3 },
    }));

    expect(resolveGlobalSessionDirectory(useGlobalSessionsStore.getState().activeSessions[0])).toBe('/repo/app-worktree');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')).toBe(undefined);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app-worktree')?.[0]?.id).toBe('ses_1');
  });

  test('preserves directory metadata when moving a session to archived', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      time: { created: 1, updated: 3, archived: 4 },
    }));

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(resolveGlobalSessionDirectory(useGlobalSessionsStore.getState().archivedSessions[0])).toBe('/repo/app');
  });

  test('preserves the opposite session-list reference during an upsert', () => {
    const active = buildSession('https://share.example/active');
    const archived = buildSession('https://share.example/archived', {
      id: 'ses_archived',
      time: { created: 1, updated: 2, archived: 3 },
    });
    useGlobalSessionsStore.getState().applySnapshot([active], [archived]);

    const archivedSessions = useGlobalSessionsStore.getState().archivedSessions;
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/active-updated', {
      time: { created: 1, updated: 3 },
    }));
    expect(useGlobalSessionsStore.getState().archivedSessions).toBe(archivedSessions);

    const activeSessions = useGlobalSessionsStore.getState().activeSessions;
    useGlobalSessionsStore.getState().upsertSession({
      ...archived,
      time: { created: 1, updated: 4, archived: 3 },
    });
    expect(useGlobalSessionsStore.getState().activeSessions).toBe(activeSessions);
  });

  test('applies a batch of session upserts in one store publication', () => {
    let publications = 0;
    const unsubscribe = useGlobalSessionsStore.subscribe(() => {
      publications += 1;
    });

    useGlobalSessionsStore.getState().upsertSessions([
      buildSession('https://share.example/a'),
      buildSession('https://share.example/b', { id: 'ses_2' }),
    ]);

    unsubscribe();
    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['ses_2', 'ses_1']);
    expect(publications).toBe(1);
  });
});

describe('mergeLiveSessionWithGlobalSession', () => {
  test('preserves global share over live share', () => {
    const live = buildSession('https://live.example/s', { time: { created: 1, updated: 5 } });
    const global = buildSession('https://global.example/s', { time: { created: 1, updated: 3 } });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(merged.share?.url).toBe('https://global.example/s');
    expect(merged.time?.updated).toBe(5);
  });

  test('preserves directory from global when live omits it', () => {
    const live = buildSession('https://live.example/s', { time: { created: 1, updated: 5 } });
    const global = buildSession('https://global.example/s', { directory: '/repo/app' });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(resolveGlobalSessionDirectory(merged)).toBe('/repo/app');
  });

  test('live directory takes precedence over global when present', () => {
    const live = buildSession('https://live.example/s', { directory: '/repo/worktree' });
    const global = buildSession('https://global.example/s', { directory: '/repo/app' });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(resolveGlobalSessionDirectory(merged)).toBe('/repo/worktree');
  });
});

describe('combineActiveSessionsWithLive', () => {
  const listSession = (id: string, extra: SessionExtra = {}): Session => ({
    id,
    title: id,
    time: { created: 1, updated: 2 },
    ...extra,
  } as Session);

  test('merges a live update into its global active session exactly once', () => {
    const global = listSession('ses_1', { directory: '/repo/app', share: { url: 'https://global.example/s' } });
    const live = listSession('ses_1', { title: 'Live title', time: { created: 1, updated: 9 } });

    const combined = combineActiveSessionsWithLive({
      globalActiveSessions: [global],
      globalArchivedSessions: [],
      liveSessions: [live],
    });

    expect(combined.map((session) => session.id)).toEqual(['ses_1']);
    expect(combined[0].title).toBe('Live title');
    expect(combined[0].time?.updated).toBe(9);
    // Live payloads omit share/directory metadata the global cache owns.
    expect(combined[0].share?.url).toBe('https://global.example/s');
    expect(resolveGlobalSessionDirectory(combined[0])).toBe('/repo/app');
  });

  test('keeps a live-only session that is not known to be archived', () => {
    const combined = combineActiveSessionsWithLive({
      globalActiveSessions: [],
      globalArchivedSessions: [],
      liveSessions: [listSession('ses_live_only')],
    });

    expect(combined.map((session) => session.id)).toEqual(['ses_live_only']);
  });

  test('drops a globally archived session even when a stale live copy still has it', () => {
    const combined = combineActiveSessionsWithLive({
      globalActiveSessions: [listSession('ses_other')],
      globalArchivedSessions: [listSession('ses_archived', { time: { created: 1, updated: 2, archived: 3 } })],
      liveSessions: [listSession('ses_archived'), listSession('ses_other')],
    });

    expect(combined.map((session) => session.id)).toEqual(['ses_other']);
  });

  test('keeps a session listed as archived without an archived timestamp', () => {
    // The OpenCode archived query returns active sessions too; a record with no
    // `time.archived` is not evidence of archival and must not hide a session.
    const combined = combineActiveSessionsWithLive({
      globalActiveSessions: [listSession('ses_active')],
      globalArchivedSessions: [listSession('ses_active')],
      liveSessions: [],
    });

    expect(combined.map((session) => session.id)).toEqual(['ses_active']);
  });

  test('keeps a live-only session that is listed as archived without an archived timestamp', () => {
    const combined = combineActiveSessionsWithLive({
      globalActiveSessions: [],
      globalArchivedSessions: [listSession('ses_live_only')],
      liveSessions: [listSession('ses_live_only')],
    });

    expect(combined.map((session) => session.id)).toEqual(['ses_live_only']);
  });

  test('archived membership wins when the same id is in both global lists and live', () => {
    const combined = combineActiveSessionsWithLive({
      globalActiveSessions: [listSession('ses_raced'), listSession('ses_kept')],
      globalArchivedSessions: [listSession('ses_raced', { time: { created: 1, updated: 2, archived: 3 } })],
      liveSessions: [listSession('ses_raced', { title: 'Live raced' })],
    });

    expect(combined.map((session) => session.id)).toEqual(['ses_kept']);
  });

  test('does not repeat a live-only session that appears twice in the live list', () => {
    const combined = combineActiveSessionsWithLive({
      globalActiveSessions: [listSession('ses_global')],
      globalArchivedSessions: [],
      liveSessions: [
        listSession('ses_global'),
        listSession('ses_live_only'),
        listSession('ses_live_only'),
      ],
    });

    expect(combined.map((session) => session.id)).toEqual(['ses_global', 'ses_live_only']);
  });

  test('preserves global active order and appends live-only sessions after it', () => {
    const combined = combineActiveSessionsWithLive({
      globalActiveSessions: [listSession('ses_c'), listSession('ses_a'), listSession('ses_b')],
      globalArchivedSessions: [listSession('ses_a', { time: { created: 1, updated: 2, archived: 3 } })],
      liveSessions: [listSession('ses_z'), listSession('ses_b'), listSession('ses_y')],
    });

    expect(combined.map((session) => session.id)).toEqual(['ses_c', 'ses_b', 'ses_z', 'ses_y']);
  });
});

describe('isGlobalSessionRecencyOnlyUpdate', () => {
  test('accepts an updated timestamp while preserving omitted directory metadata', () => {
    const existing = buildSession('https://share.example/s', {
      directory: '/repo/app',
      time: { created: 1, updated: 2 },
    });
    const incoming = buildSession('https://share.example/s', {
      time: { created: 1, updated: 3 },
    });

    expect(isGlobalSessionRecencyOnlyUpdate(existing, incoming)).toBe(true);
  });

  test('rejects title and archive changes as structural updates', () => {
    const existing = buildSession('https://share.example/s', { time: { created: 1, updated: 2 } });
    const renamed = buildSession('https://share.example/s', {
      title: 'Renamed',
      time: { created: 1, updated: 3 },
    });
    const archived = buildSession('https://share.example/s', {
      time: { created: 1, updated: 3, archived: 4 },
    });

    expect(isGlobalSessionRecencyOnlyUpdate(existing, renamed)).toBe(false);
    expect(isGlobalSessionRecencyOnlyUpdate(existing, archived)).toBe(false);
  });

  test('rejects parent and slug changes as structural updates', () => {
    const existing = buildSession('https://share.example/s', {
      parentID: 'parent-a',
      slug: 'slug-a',
      time: { created: 1, updated: 2 },
    });
    const reparented = buildSession('https://share.example/s', {
      parentID: 'parent-b',
      slug: 'slug-a',
      time: { created: 1, updated: 3 },
    });
    const reslugged = buildSession('https://share.example/s', {
      parentID: 'parent-a',
      slug: 'slug-b',
      time: { created: 1, updated: 3 },
    });

    expect(isGlobalSessionRecencyOnlyUpdate(existing, reparented)).toBe(false);
    expect(isGlobalSessionRecencyOnlyUpdate(existing, reslugged)).toBe(false);
  });
});
