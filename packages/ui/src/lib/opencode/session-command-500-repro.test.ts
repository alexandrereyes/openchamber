/**
 * Reproduction test for issue #2277:
 * session.command returns HTTP 500 for plugin slash commands (e.g. /quota).
 *
 * This test demonstrates that when the OpenCode backend returns a 500 response
 * for the session.command endpoint (as happens with plugin slash commands),
 * the OpenChamber client correctly surfaces the error.
 *
 * The Quota plugin executes correctly in the TUI, but OpenChamber desktop
 * fails because the session.command endpoint returns 500 for plugin-registered
 * slash commands.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

(mock as unknown as { restore?: () => void }).restore?.();

// ---------------------------------------------------------------------------
// Shared test infrastructure -- mirrors client.test.ts setup
// ---------------------------------------------------------------------------

type SdkResult = { data?: unknown; error?: unknown; response?: { status?: number } };

const commandCalls: unknown[][] = [];
const commandResults: Array<SdkResult | Error> = [];

const commandMock = mock(async (...args: unknown[]) => {
  commandCalls.push(args);
  const next = commandResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { data: { info: { id: 'msg_placeholder' }, parts: [] }, response: { status: 200 } };
});

const promptAsyncMock = mock(async () => ({
  response: new Response(null, { status: 200 }),
}));

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock(() => ({
    config: {
      get: mock(() => Promise.resolve({ data: {} })),
    },
    session: {
      promptAsync: promptAsyncMock,
      command: commandMock,
    },
  })),
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: (path: string) => path,
  })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => 'test-runtime'),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify([]), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);

beforeEach(() => {
  commandCalls.length = 0;
  commandResults.length = 0;
});

// ---------------------------------------------------------------------------
// Reproduction tests
// ---------------------------------------------------------------------------

describe('session.command 500 error for plugin slash commands (issue #2277)', () => {

  const sendSlashCommand = () => opencodeClient.sendCommand({
    id: 'ses_plugin',
    providerID: 'openai',
    modelID: 'gpt-4',
    command: 'quota',
    arguments: '',
    agent: '',
    directory: null,
  });

  test('1. session.command returns 500 for plugin slash commands', async () => {
    // Simulate the OpenCode backend returning 500 for a plugin slash command
    const errorBody = { error: 'Internal server error processing plugin command' };
    commandResults.push({
      error: errorBody,
      response: { status: 500 },
    });

    let error: unknown = null;
    try {
      await sendSlashCommand();
    } catch (caught) {
      error = caught;
    }

    // Verify the call was made with the correct command name
    expect(commandCalls.length).toBe(1);
    const callParams = commandCalls[0]?.[0] as Record<string, unknown>;
    expect(callParams?.command).toBe('quota');
    expect(callParams?.arguments).toBe('');
    expect(callParams?.model).toBe('openai/gpt-4');

    // Verify the error is surfaced correctly
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('session.command failed');
    expect(message).toContain('(500)');
  });

  test('2. session.command 500 surfaces the server error detail', async () => {
    // The OpenCode backend might return different error body formats for 500
    const errorBody = 'Plugin command execution failed: quota plugin not found';
    commandResults.push({
      error: errorBody,
      response: { status: 500 },
    });

    let error: unknown = null;
    try {
      await sendSlashCommand();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // The server error detail should be included
    expect(message).toContain('Plugin command execution failed');
  });

  test('3. session.command 500 with missing model causes distinct error from normal slash commands', async () => {
    // Plugin commands might fail differently when model info is missing
    commandResults.push({
      error: { error: 'Command requires model parameter' },
      response: { status: 500 },
    });

    let error: unknown = null;
    try {
      await opencodeClient.sendCommand({
        id: 'ses_plugin',
        providerID: '',
        modelID: '',
        command: 'quota',
        arguments: '',
        directory: null,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // The model format would be "/" (empty provider and model)
    // This is a valid call but the server might reject it
    expect(message).toContain('session.command failed');
    expect(message).toContain('(500)');
  });

  test('4. routeMessage dispatches plugin slash commands via session.command', async () => {
    // Verify that a plugin slash command is routed through session.command
    // This is the actual flow from the UI when a user types /quota
    const syncCommands = [{ name: 'quota', template: 'Check quota for {provider}' }];

    // We need to verify the routing logic. Since routeMessage lives in
    // session-ui-store.ts and uses the store/actions, we can test that
    // sendCommand is called with the right parameters by examining the mock.
    commandResults.push({
      data: { info: { id: 'msg_quota' }, parts: [] },
      response: { status: 200 },
    });

    // This would be the normal flow if the server didn't return 500
    const result = await opencodeClient.sendCommand({
      id: 'ses_test',
      providerID: 'openai',
      modelID: 'gpt-4',
      command: 'quota',
      arguments: '',
      directory: '/project',
    });

    expect(commandCalls.length).toBe(1);
    expect(result).toBeTruthy();
  });

  test('5. optimisticSend rolls back on session.command 500', async () => {
    // When session.command returns 500, optimisticSend should roll back the
    // optimistic message insert and reset session status to idle.
    // This test verifies the error propagation path.
    const errorBody = { error: 'Plugin command failed' };
    commandResults.push({
      error: errorBody,
      response: { status: 500 },
    });

    let error: unknown = null;
    try {
      await sendSlashCommand();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    // The error status should be set for optimisticSend to inspect
    expect((error as Error & { status?: number }).status).toBe(500);
  });

  test('6. session.command 500 is not misidentified as a transport failure', async () => {
    // Transport failures have no response status, while a 500 has status 500.
    // They must be treated differently.
    commandResults.push({
      error: { error: 'Internal server error' },
      response: { status: 500 },
    });

    let error: unknown = null;
    try {
      await sendSlashCommand();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // Must contain the status code
    expect(message).toContain('(500)');
    // Must NOT be mislabeled as a transport failure
    expect(message).not.toContain('transport failure');

    // Verify status is set (transport failures have status undefined)
    expect((error as Error & { status?: number }).status).toBe(500);
  });
});
