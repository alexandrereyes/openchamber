import { describe, expect, it, vi } from 'vitest';
import { __testing, generateWalkthroughText } from './inference.js';
import { OPENCHAMBER_INTERNAL_SESSION_KIND } from '../opencode/internal-sessions.js';

const result = (data) => ({ data });

const createHarness = ({ deleteError = null, wait = false } = {}) => {
  const create = vi.fn(async () => result({ id: 'ses_internal' }));
  const promptAsync = vi.fn(async () => ({}));
  const status = vi.fn(async () => result({ ses_internal: { type: wait ? 'busy' : 'idle' } }));
  const messages = vi.fn(async () => result(wait ? [] : [{
    info: {
      id: 'msg_assistant',
      role: 'assistant',
      parentID: expect.anything(),
      finish: 'stop',
      structured: { title: 'Change' },
      time: { created: 1, completed: 2 },
    },
    parts: [],
  }]));
  const abort = vi.fn(async () => result(true));
  const remove = vi.fn(async () => deleteError ? ({ error: deleteError, response: { status: 500 } }) : result(true));
  const list = vi.fn(async () => result([]));
  const client = { session: { create, promptAsync, status, messages, abort, delete: remove }, experimental: { session: { list } } };
  return { client, createClient: () => client, create, promptAsync, status, messages, abort, remove, list };
};

describe('walkthrough OpenCode inference', () => {
  it('normalizes real SDK endpoint and assistant error shapes', () => {
    const cases = [
      [{ name: 'MessageOutputLengthError', data: {} }, 'output-exhausted'],
      [{ name: 'ContextOverflowError', data: { message: 'context too long' } }, 'context-too-small'],
      [{ name: 'ProviderAuthError', data: { providerID: 'p', message: 'login required' } }, 'no-provider-login'],
      [{ name: 'StructuredOutputError', data: { message: 'could not match schema', retries: 2 } }, 'structured-output-unsupported'],
      [{ name: 'APIError', data: { message: 'response_format json_schema is not supported', statusCode: 400, isRetryable: false } }, 'structured-output-unsupported'],
    ];
    for (const [payload, code] of cases) {
      expect(__testing.normalizedOpenCodeError(payload, 'test').code).toBe(code);
    }
    const generic = __testing.normalizedOpenCodeError({
      name: 'APIError', data: { message: 'invalid model', statusCode: 400, isRetryable: false },
    }, 'test');
    expect(generic.code).toBeUndefined();
    expect(generic.status).toBe(400);
    expect(generic.statusCode).toBe(502);
  });

  it('removes the sleep abort listener after the timer resolves', async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, 'addEventListener');
    const remove = vi.spyOn(signal, 'removeEventListener');
    const sleeping = __testing.sleep(10, signal);
    await vi.advanceTimersByTimeAsync(10);
    await sleeping;
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    vi.useRealTimers();
  });

  it('creates a marked restricted session and returns only the correlated terminal assistant output', async () => {
    const harness = createHarness();
    harness.messages.mockImplementation(async () => {
      const promptId = harness.promptAsync.mock.calls[0][0].messageID;
      return result([
        { info: { role: 'assistant', parentID: 'old', finish: 'stop', time: { completed: 1 } }, parts: [{ type: 'text', text: 'old' }] },
        { info: { role: 'assistant', parentID: promptId, finish: 'stop', structured: { title: 'Change' }, time: { completed: 2 } }, parts: [] },
      ]);
    });

    const output = await generateWalkthroughText({
      prompt: 'prompt', system: 'system', directory: '/repo',
      model: { providerID: 'anthropic', modelID: 'haiku' }, responseSchema: { type: 'object' },
      timeoutMs: 1_000, baseUrl: 'http://opencode', createClient: harness.createClient, pollIntervalMs: 1,
    });

    expect(output).toEqual({ text: '{"title":"Change"}' });
    expect(harness.create).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      metadata: { openchamber: { internalSession: { kind: OPENCHAMBER_INTERNAL_SESSION_KIND, version: 1 } } },
      permission: [{ permission: '*', pattern: '*', action: 'deny' }],
    }), expect.anything());
    expect(harness.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'anthropic', modelID: 'haiku' },
      tools: expect.objectContaining({ bash: false, question: false, read: false, write: false }),
      format: { type: 'json_schema', schema: { type: 'object' } },
    }), expect.anything());
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it('aborts on explicit cancellation and still attempts deletion', async () => {
    const harness = createHarness({ wait: true });
    const controller = new AbortController();
    const running = generateWalkthroughText({
      prompt: 'prompt', system: 'system', directory: '/repo', model: { providerID: 'p', modelID: 'm' },
      timeoutMs: 5_000, signal: controller.signal, baseUrl: 'http://opencode',
      createClient: harness.createClient, pollIntervalMs: 1,
    });
    await vi.waitFor(() => expect(harness.promptAsync).toHaveBeenCalled());
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it('aborts the OpenCode turn when the generation deadline expires', async () => {
    const harness = createHarness({ wait: true });
    await expect(generateWalkthroughText({
      prompt: 'prompt', system: 'system', directory: '/repo', model: { providerID: 'p', modelID: 'm' },
      timeoutMs: 5, baseUrl: 'http://opencode', createClient: harness.createClient, pollIntervalMs: 1,
    })).rejects.toThrow();
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it('does not replace a successful result when cleanup fails', async () => {
    const harness = createHarness({ deleteError: new Error('cleanup failed') });
    harness.messages.mockImplementation(async () => {
      const promptId = harness.promptAsync.mock.calls[0][0].messageID;
      return result([{ info: { role: 'assistant', parentID: promptId, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: '{"title":"Change"}' }] }]);
    });
    await expect(generateWalkthroughText({
      prompt: 'prompt', system: 'system', directory: '/repo', model: { providerID: 'p', modelID: 'm' },
      timeoutMs: 1_000, baseUrl: 'http://opencode', createClient: harness.createClient, pollIntervalMs: 1,
    })).resolves.toEqual({ text: '{"title":"Change"}' });
  });

  it('deletes a pre-existing marked orphan during bounded first-use cleanup', async () => {
    __testing.requireOrphanCleanup();
    const harness = createHarness();
    harness.list.mockResolvedValue(result([{ id: 'ses_orphan', directory: '/repo', metadata: {
      openchamber: { internalSession: { kind: OPENCHAMBER_INTERNAL_SESSION_KIND, version: 1 } },
    } }]));
    harness.messages.mockImplementation(async () => {
      const promptId = harness.promptAsync.mock.calls[0][0].messageID;
      return result([{ info: { role: 'assistant', parentID: promptId, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: '{}' }] }]);
    });
    await generateWalkthroughText({ prompt: 'p', system: 's', directory: '/repo', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 1_000, baseUrl: 'http://opencode', createClient: harness.createClient, pollIntervalMs: 1 });
    expect(harness.remove.mock.calls.some(([request]) => request.sessionID === 'ses_orphan')).toBe(true);
    const abortIndex = harness.abort.mock.invocationCallOrder[0];
    const orphanDeleteCall = harness.remove.mock.calls.findIndex(([request]) => request.sessionID === 'ses_orphan');
    expect(abortIndex).toBeLessThan(harness.remove.mock.invocationCallOrder[orphanDeleteCall]);
  });

  it('does not orphan-clean a session owned by a live walkthrough', async () => {
    const harness = createHarness();
    let release;
    harness.messages.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const running = generateWalkthroughText({ prompt: 'p', system: 's', directory: '/repo', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 1_000, baseUrl: 'http://opencode', createClient: harness.createClient, pollIntervalMs: 1 });
    await vi.waitFor(() => expect(harness.create).toHaveBeenCalledOnce());
    const activeId = 'ses_internal';
    __testing.requireOrphanCleanup();
    harness.list.mockResolvedValue(result([{ id: activeId, directory: '/repo', metadata: { openchamber: { internalSession: { kind: OPENCHAMBER_INTERNAL_SESSION_KIND } } } }]));
    const second = createHarness();
    second.create.mockResolvedValue(result({ id: 'ses_second' }));
    second.list = harness.list;
    second.client.experimental.session.list = harness.list;
    second.messages.mockImplementation(async () => {
      const promptId = second.promptAsync.mock.calls[0][0].messageID;
      return result([{ info: { role: 'assistant', parentID: promptId, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: '{}' }] }]);
    });
    await generateWalkthroughText({ prompt: 'p2', system: 's', directory: '/repo2', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 1_000, baseUrl: 'http://opencode', createClient: second.createClient, pollIntervalMs: 1 });
    expect(second.remove.mock.calls.some(([request]) => request.sessionID === activeId)).toBe(false);
    const promptId = harness.promptAsync.mock.calls[0][0].messageID;
    release(result([{ info: { role: 'assistant', parentID: promptId, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: '{}' }] }]));
    await running;
  });

  it('retries orphan reconciliation after a cleanup failure', async () => {
    __testing.requireOrphanCleanup();
    const failed = createHarness({ deleteError: { name: 'APIError', data: { message: 'delete failed', statusCode: 500, isRetryable: true } } });
    failed.messages.mockImplementation(async () => {
      const promptId = failed.promptAsync.mock.calls[0][0].messageID;
      return result([{ info: { role: 'assistant', parentID: promptId, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: '{}' }] }]);
    });
    await generateWalkthroughText({ prompt: 'p', system: 's', directory: '/repo', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 1_000, baseUrl: 'http://opencode', createClient: failed.createClient, pollIntervalMs: 1 });

    const retry = createHarness();
    retry.messages.mockImplementation(async () => {
      const promptId = retry.promptAsync.mock.calls[0][0].messageID;
      return result([{ info: { role: 'assistant', parentID: promptId, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: '{}' }] }]);
    });
    await generateWalkthroughText({ prompt: 'p', system: 's', directory: '/repo', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 1_000, baseUrl: 'http://opencode', createClient: retry.createClient, pollIntervalMs: 1 });
    expect(retry.list).toHaveBeenCalledOnce();
  });

  it('rescans a full page until more than twenty eligible orphans are handled before advancing', async () => {
    __testing.requireOrphanCleanup();
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      id: `ses_page_${index}`,
      directory: '/repo',
      time: { updated: 100 - index },
      ...(index < 25 ? { metadata: { openchamber: { internalSession: { kind: OPENCHAMBER_INTERNAL_SESSION_KIND } } } } : {}),
    }));
    const first = createHarness();
    first.list.mockResolvedValue(result(sessions));
    first.messages.mockImplementation(async () => {
      const promptId = first.promptAsync.mock.calls[0][0].messageID;
      return result([{ info: { role: 'assistant', parentID: promptId, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: '{}' }] }]);
    });
    await generateWalkthroughText({ prompt: 'p', system: 's', directory: '/repo', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 1_000, baseUrl: 'http://opencode', createClient: first.createClient, pollIntervalMs: 1 });
    expect(first.list.mock.calls[0][0].cursor).toBeUndefined();
    expect(first.remove.mock.calls.filter(([request]) => request.sessionID.startsWith('ses_page_'))).toHaveLength(20);

    const remaining = createHarness();
    remaining.create.mockResolvedValue(result({ id: 'ses_second_pass' }));
    remaining.list.mockResolvedValue(result(sessions.map((session, index) => (
      index < 20 ? { ...session, metadata: undefined } : session
    ))));
    remaining.messages.mockImplementation(async () => {
      const promptId = remaining.promptAsync.mock.calls[0][0].messageID;
      return result([{ info: { role: 'assistant', parentID: promptId, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: '{}' }] }]);
    });
    await generateWalkthroughText({ prompt: 'p2', system: 's', directory: '/repo', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 1_000, baseUrl: 'http://opencode', createClient: remaining.createClient, pollIntervalMs: 1 });
    expect(remaining.list.mock.calls[0][0].cursor).toBeUndefined();
    expect(remaining.remove.mock.calls.filter(([request]) => request.sessionID.startsWith('ses_page_'))).toHaveLength(5);
  });

  it('maps an SDK-shaped prompt endpoint error before cleanup', async () => {
    const harness = createHarness();
    harness.promptAsync.mockResolvedValue({
      error: { name: 'ProviderAuthError', data: { providerID: 'p', message: 'login required' } },
      response: { status: 401 },
    });
    await expect(generateWalkthroughText({
      prompt: 'p', system: 's', directory: '/repo', model: { providerID: 'p', modelID: 'm' },
      timeoutMs: 1_000, baseUrl: 'http://opencode', createClient: harness.createClient, pollIntervalMs: 1,
    })).rejects.toMatchObject({ code: 'no-provider-login', statusCode: 401 });
    expect(harness.remove).toHaveBeenCalledOnce();
  });
});
