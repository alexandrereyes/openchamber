import { describe, expect, it, vi } from 'vitest';
import {
  computeNextRunAt,
  createScheduledTasksRuntime,
  formatScheduledSessionTitle,
  parseScheduledCommandPrompt,
} from './runtime.js';

const createRunnableTask = (lastSessionId) => ({
  id: 'task-1',
  name: 'Cleanup test',
  enabled: true,
  schedule: {
    kind: 'daily',
    times: ['23:59'],
    timezone: 'UTC',
  },
  execution: {
    prompt: '/test',
    providerID: 'provider',
    modelID: 'model',
  },
  state: {
    createdAt: 1,
    updatedAt: 1,
    lastStatus: 'success',
    ...(lastSessionId ? { lastSessionId } : {}),
  },
});

const createRuntimeHarness = async ({
  lastSessionId,
  previousSession = { id: 'previous-session', time: {} },
  previousStatus = { type: 'idle' },
  statusError,
  archiveError,
  pendingGet = false,
  cleanupTimeoutMs = 100,
} = {}) => {
  let task = createRunnableTask(lastSessionId);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const client = {
    command: {
      list: vi.fn(async () => ({ data: [{ name: 'test' }] })),
    },
    session: {
      get: vi.fn(async () => {
        if (pendingGet) {
          return new Promise(() => {});
        }
        return { data: previousSession };
      }),
      status: vi.fn(async () => {
        if (statusError) {
          throw statusError;
        }
        return {
          data: { 'previous-session': previousStatus },
        };
      }),
      update: vi.fn(async (input) => {
        if (archiveError) {
          throw archiveError;
        }
        return {
          data: {
            ...previousSession,
            time: { ...previousSession.time, archived: input.time.archived },
          },
        };
      }),
      create: vi.fn(async () => ({ data: { id: 'new-session' } })),
      command: vi.fn(async () => ({ data: true })),
    },
  };
  const projectConfigRuntime = {
    listScheduledTasks: vi.fn(async () => [task]),
    updateScheduledTaskState: vi.fn(async (_projectID, _taskID, patch) => {
      task = {
        ...task,
        state: { ...task.state, ...patch },
      };
      return { task, tasks: [task] };
    }),
    upsertScheduledTask: vi.fn(async (_projectID, input) => {
      task = input;
      return { task, tasks: [task], created: false };
    }),
  };
  const runtime = createScheduledTasksRuntime({
    projectConfigRuntime,
    listProjects: async () => [{ id: 'project-1', path: '/repo' }],
    buildOpenCodeUrl: () => 'http://opencode.test/',
    getOpenCodeAuthHeaders: () => ({}),
    createOpenCodeClient: () => client,
    previousSessionCleanupTimeoutMs: cleanupTimeoutMs,
    logger,
  });
  await runtime.syncProject('project-1');

  return {
    client,
    logger,
    run: () => runtime.runNow('project-1', 'task-1'),
  };
};

describe('scheduled-tasks runtime helpers', () => {
  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
  });
});

describe('scheduled task previous session cleanup', () => {
  it('does nothing when there is no lastSessionId', async () => {
    const harness = await createRuntimeHarness();

    const result = await harness.run();

    expect(result).toMatchObject({ ok: true, sessionID: 'new-session' });
    expect(harness.client.session.get).not.toHaveBeenCalled();
    expect(harness.client.session.update).not.toHaveBeenCalled();
  });

  it('keeps an existing archive timestamp unchanged', async () => {
    const previousSession = {
      id: 'previous-session',
      time: { archived: 123 },
    };
    const harness = await createRuntimeHarness({
      lastSessionId: 'previous-session',
      previousSession,
    });

    const result = await harness.run();

    expect(result.ok).toBe(true);
    expect(previousSession.time.archived).toBe(123);
    expect(harness.client.session.status).not.toHaveBeenCalled();
    expect(harness.client.session.update).not.toHaveBeenCalled();
  });

  it('archives an authoritatively idle previous session before creating the new session', async () => {
    const harness = await createRuntimeHarness({ lastSessionId: 'previous-session' });

    const result = await harness.run();

    expect(result.ok).toBe(true);
    expect(harness.client.session.status).toHaveBeenCalledWith(
      { directory: '/repo' },
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.client.session.update).toHaveBeenCalledWith(
      {
        sessionID: 'previous-session',
        directory: '/repo',
        time: { archived: expect.any(Number) },
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.client.session.update.mock.invocationCallOrder[0])
      .toBeLessThan(harness.client.session.create.mock.invocationCallOrder[0]);
  });

  it.each(['busy', 'retry'])('does not archive a previous session in %s status', async (type) => {
    const harness = await createRuntimeHarness({
      lastSessionId: 'previous-session',
      previousStatus: { type },
    });

    const result = await harness.run();

    expect(result.ok).toBe(true);
    expect(harness.client.session.update).not.toHaveBeenCalled();
    expect(harness.client.session.create).toHaveBeenCalledOnce();
  });

  it('logs a status query failure and continues the new execution without archiving', async () => {
    const harness = await createRuntimeHarness({
      lastSessionId: 'previous-session',
      statusError: new Error('status query failed'),
    });

    const result = await harness.run();

    expect(result).toMatchObject({ ok: true, sessionID: 'new-session' });
    expect(harness.client.session.update).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      '[ScheduledTasks] failed to clean up previous session',
      expect.objectContaining({ error: 'status query failed' }),
    );
  });

  it('logs an archive failure and continues the new execution without false confirmation', async () => {
    const harness = await createRuntimeHarness({
      lastSessionId: 'previous-session',
      archiveError: new Error('archive failed'),
    });

    const result = await harness.run();

    expect(result).toMatchObject({ ok: true, sessionID: 'new-session' });
    expect(harness.client.session.update).toHaveBeenCalledOnce();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      '[ScheduledTasks] failed to clean up previous session',
      expect.objectContaining({ error: 'archive failed' }),
    );
  });

  it('treats cleanup timeout as a logged failure and continues the new execution', async () => {
    const harness = await createRuntimeHarness({
      lastSessionId: 'previous-session',
      pendingGet: true,
      cleanupTimeoutMs: 5,
    });

    const result = await harness.run();

    expect(result).toMatchObject({ ok: true, sessionID: 'new-session' });
    expect(harness.client.session.update).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      '[ScheduledTasks] failed to clean up previous session',
      expect.objectContaining({ error: 'previous session cleanup timed out' }),
    );
  });
});
