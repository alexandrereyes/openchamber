import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { forgetOpenChamberInternalSession, internalSessionMetadata, trackOpenChamberInternalSession } from '../opencode/internal-sessions.js';

const POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 2_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const DISABLED_TOOLS = Object.fromEntries([
  'bash', 'edit', 'glob', 'grep', 'patch', 'question', 'read', 'skill',
  'task', 'todoread', 'todowrite', 'webfetch', 'write',
].map((tool) => [tool, false]));
let orphanCleanupNeeded = true;
let orphanCleanupCursor;
const activeSessionIds = new Set();

const isRecord = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]';

export const resetWalkthroughInferenceRuntime = () => {
  orphanCleanupNeeded = true;
  orphanCleanupCursor = undefined;
};

const normalizedOpenCodeError = (raw, operation, responseStatus) => {
  const name = raw?.name?.constructor === String ? raw.name : 'APIError';
  const data = isRecord(raw?.data) ? raw.data : {};
  const status = Number(data.statusCode ?? responseStatus) || undefined;
  const detail = data.message?.constructor === String
    ? data.message
    : (raw?.message?.constructor === String ? raw.message : `${operation} failed`);
  let code;
  if (name === 'MessageOutputLengthError') code = 'output-exhausted';
  else if (name === 'ContextOverflowError') code = 'context-too-small';
  else if (name === 'ProviderAuthError' || status === 401 || status === 403) code = 'no-provider-login';
  else if (name === 'StructuredOutputError') code = 'structured-output-unsupported';
  else if (
    name === 'APIError'
    && status != null && status >= 400 && status < 500
    && /json.?schema|structured.?output|response.?format|schema is not supported/i.test(`${detail}\n${data.responseBody ?? ''}`)
  ) code = 'structured-output-unsupported';
  const normalized = Object.assign(new Error(`${operation} failed${status ? ` (${status})` : ''}: ${detail}`), {
    name,
    status,
    statusCode: code === 'no-provider-login' ? 401 : (code ? undefined : 502),
  });
  if (code) normalized.code = code;
  if (code === 'structured-output-unsupported' && name === 'APIError') normalized.schemaRefusal = true;
  return normalized;
};

const sdkError = (result, operation) => result?.error
  ? normalizedOpenCodeError(result.error, operation, result.response?.status)
  : null;

const requireData = (result, operation) => {
  const error = sdkError(result, operation);
  if (error) throw error;
  if (result?.data == null) throw new Error(`${operation} returned no data`);
  return result.data;
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  if (signal.aborted) return onAbort();
  signal.addEventListener('abort', onAbort, { once: true });
});

const assistantOutcomeFor = (messages, promptMessageId) => {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const info = message?.info;
    if (info?.role !== 'assistant' || info.parentID !== promptMessageId) continue;
    if (!info.time?.completed) return null;
    if (info.error) return { error: normalizedOpenCodeError(info.error, 'assistant message') };
    if (!info.finish) return null;
    if (info.finish === 'length' || info.finish === 'max_tokens') {
      return { error: Object.assign(new Error('The model exhausted its output allowance'), { code: 'output-exhausted' }) };
    }
    if (info.structured != null) return { result: { text: JSON.stringify(info.structured) } };
    const text = Array.isArray(message.parts)
      ? message.parts.filter((part) => part?.type === 'text' && part.text?.constructor === String).map((part) => part.text).join('\n').trim()
      : '';
    return text ? { result: { text } } : null;
  }
  return null;
};

const cleanupOrphanedWalkthroughSessions = async (client) => {
  if (!orphanCleanupNeeded || !(client.experimental?.session?.list instanceof Function)) return;
  orphanCleanupNeeded = false;
  try {
    const listRequest = { archived: true, limit: 100 };
    if (orphanCleanupCursor !== undefined) listRequest.cursor = orphanCleanupCursor;
    const listed = await client.experimental.session.list(
      listRequest,
      { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
    );
    const error = sdkError(listed, 'experimental.session.list');
    if (error) throw error;
    const listedSessions = Array.isArray(listed.data) ? listed.data : [];
    const eligibleOrphans = listedSessions
      .filter((session) => session?.metadata?.openchamber?.internalSession?.kind === 'walkthrough-inference')
      .filter((session) => !activeSessionIds.has(session.id));
    const orphans = eligibleOrphans.slice(0, 20);
    const lastUpdated = listedSessions.at(-1)?.time?.updated;
    const pageHasUnprocessedOrphans = eligibleOrphans.length > orphans.length;
    if (!pageHasUnprocessedOrphans) {
      orphanCleanupCursor = listedSessions.length === 100 && Number.isFinite(lastUpdated) ? lastUpdated : undefined;
    }
    if (pageHasUnprocessedOrphans || orphanCleanupCursor !== undefined) orphanCleanupNeeded = true;
    for (let index = 0; index < orphans.length; index += 2) {
      await Promise.all(orphans.slice(index, index + 2).map(async (session) => {
        trackOpenChamberInternalSession(session.id);
        await client.session.abort(
          { sessionID: session.id, directory: session.directory },
          { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
        ).catch(() => {});
        const removed = await client.session.delete(
          { sessionID: session.id, directory: session.directory },
          { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
        );
        if (removed?.error && removed.response?.status !== 404) orphanCleanupNeeded = true;
        else forgetOpenChamberInternalSession(session.id);
      }));
    }
  } catch {
    orphanCleanupNeeded = true;
  }
};

export async function generateWalkthroughText({
  prompt, system, directory, model, responseSchema, timeoutMs, signal, baseUrl, headers,
  createClient = createOpencodeClient, pollIntervalMs = POLL_INTERVAL_MS,
}) {
  if (!baseUrl) throw new Error('OpenCode API is unavailable');
  const client = createClient({ baseUrl: baseUrl.replace(/\/$/, ''), headers: headers ?? {} });
  await cleanupOrphanedWalkthroughSessions(client);
  const deadline = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const requestOptions = () => ({ signal: combinedSignal });
  const promptMessageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
  let sessionId = '';
  let pollDelayMs = pollIntervalMs;

  try {
    const session = requireData(await client.session.create({
      directory,
      title: 'Changes Walkthrough',
      metadata: internalSessionMetadata(),
      permission: [{ permission: '*', pattern: '*', action: 'deny' }],
    }, requestOptions()), 'session.create');
    sessionId = session.id;
    if (!sessionId) throw new Error('session.create returned an invalid session');
    trackOpenChamberInternalSession(sessionId);
    activeSessionIds.add(sessionId);

    const promptResult = await client.session.promptAsync({
      sessionID: sessionId,
      directory,
      messageID: promptMessageId,
      model: { providerID: model.providerID, modelID: model.modelID },
      system,
      tools: DISABLED_TOOLS,
      ...(responseSchema ? { format: { type: 'json_schema', schema: responseSchema } } : { format: { type: 'text' } }),
      parts: [{ type: 'text', text: prompt }],
    }, requestOptions());
    const promptError = sdkError(promptResult, 'session.promptAsync');
    if (promptError) throw promptError;

    while (!combinedSignal.aborted) {
      const [statusResult, messagesResult] = await Promise.all([
        client.session.status({ directory }, requestOptions()),
        client.session.messages({ sessionID: sessionId, directory, limit: 20 }, requestOptions()),
      ]);
      const statusError = sdkError(statusResult, 'session.status');
      if (statusError) throw statusError;
      const messagesError = sdkError(messagesResult, 'session.messages');
      if (messagesError) throw messagesError;
      const status = statusResult.data?.[sessionId];
      const outcome = assistantOutcomeFor(messagesResult.data, promptMessageId);
      if (outcome?.error) throw outcome.error;
      if (status?.type !== 'busy' && status?.type !== 'retry' && outcome?.result) return outcome.result;
      await sleep(pollDelayMs, combinedSignal);
      pollDelayMs = Math.min(MAX_POLL_INTERVAL_MS, Math.ceil(pollDelayMs * 1.5));
    }
    throw combinedSignal.reason;
  } catch (error) {
    if (sessionId && combinedSignal.aborted) {
      await client.session.abort({ sessionID: sessionId, directory }, { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }).catch(() => {});
    }
    throw error;
  } finally {
    if (sessionId) {
      activeSessionIds.delete(sessionId);
      try {
        const removed = await client.session.delete(
          { sessionID: sessionId, directory },
          { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
        );
        if (removed?.error && removed.response?.status !== 404) orphanCleanupNeeded = true;
        else forgetOpenChamberInternalSession(sessionId);
      } catch {
        orphanCleanupNeeded = true;
      }
    }
  }
}

export const __testing = {
  normalizedOpenCodeError,
  sleep,
  requireOrphanCleanup: resetWalkthroughInferenceRuntime,
  activeSessionIds,
};
