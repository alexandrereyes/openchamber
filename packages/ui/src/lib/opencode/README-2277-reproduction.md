# Reproduction of issue #2277

## Summary

`POST /api/session/{id}/command` returns HTTP 500 when executing plugin slash commands
(e.g. `/quota`). The plugin executes correctly in the native OpenCode TUI, but OpenChamber
desktop fails to display the output.

## Test Files

1. `packages/ui/src/lib/opencode/session-command-500-repro.test.ts` - Client-side reproduction
   tests that verify the error handling flow when `session.command` returns 500.

2. Root cause analysis below.

## How to Run

```bash
bun test packages/ui/src/lib/opencode/session-command-500-repro.test.ts
```

## Root Cause Analysis

### Architecture

```
User types "/quota" in ChatInput
    │
    ▼
routeMessage() in session-ui-store.ts detects "/" prefix
    ├─ Parses "/quota" → cmdName="quota", args=""
    ├─ Looks up command in sync commands, commands store, or skills store
    └─ If found → optimisticSend() → opencodeClient.sendCommand()
                                            │
                                            ▼
                                  SDK client.session.command({...})
                                      POST /api/session/{id}/command
                                            │
                                            ▼
                                  OpenChamber Proxy (proxy.js)
                                      Rewrites /api → /, forwards to OpenCode
                                            │
                                            ▼
                                  OpenCode Backend (separate binary)
                                      Processes the plugin command
```

### Key Finding

The `session.command` endpoint is used by OpenChamber for **plugin slash commands**, but
the native TUI likely sends the same input as a **regular message** via `prompt_async`,
bypassing the `session.command` endpoint entirely.

The `session.command` endpoint (POST /session/{id}/command) and `session.promptAsync`
endpoint (POST /session/{id}/prompt_async) are different:

| Aspect | session.command | session.promptAsync |
|--------|----------------|-------------------|
| model param | string ("providerID/modelID") | object ({ providerID, modelID }) |
| Response | 200: { info, parts } | 200 (SSE stream) |
| Plugin support | May not resolve plugin-registered commands | Handles all input types |

### Most Likely Cause

The OpenCode backend's `session.command` endpoint does not properly handle **plugin-
registered slash commands**. When a plugin (like `@slkiser/opencode-quota`) registers
a slash command via the OpenCode plugin system, the `session.command` endpoint fails
to resolve the command or process it correctly, returning HTTP 500.

The native TUI works because it sends the `/quota` text as a **regular message** via
`prompt_async`, which the backend handles correctly regardless of whether it's a
plugin command or not.

### Reproduction Tests

The test file `session-command-500-repro.test.ts` verifies:

1. **`session.command` returns 500 for plugin slash commands** - When the SDK returns
   500, `sendCommand` correctly throws `Error("session.command failed (500): ...")`.

2. **The server error detail is surfaced** - The error message includes the response
   body from the server.

3. **Missing model causes distinct error** - When model info is empty, the error
   message still correctly identifies the 500 status.

4. **`routeMessage` dispatches plugin slash commands via `session.command`** - The
   full flow from UI to API is verified.

5. **`optimisticSend` rolls back on `session.command` 500** - The error has the
   `.status` property set to 500, allowing proper rollback handling.

6. **`session.command` 500 is not misidentified as a transport failure** - Transport
   failures (no response status) and 500 errors (with status 500) are distinguished.

### Next Steps

1. Confirm whether the native OpenCode TUI uses `prompt_async` instead of `session.command`
   for plugin slash commands.
2. If so, this confirms the root cause is in the OpenCode backend's `session.command`
   handler for plugin-registered commands.
3. If not, compare the exact HTTP request bodies sent by OpenChamber vs the TUI to
   identify any differences in request format.
