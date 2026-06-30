# Reproduction: Issue #1944 - Chat bubble displays empty string for `!`command`` expressions

## Bug Description

When using an OpenCode command file (`.md`) that contains `!`command`` expressions (inline shell execution), the chat bubble in OpenChamber renders these expressions as **empty strings** instead of the actual command output. The actual execution works correctly — the command is properly resolved for execution — but the display shows a blank.

## Root Cause Analysis

The `!`command`` (backtick) inline shell execution syntax is an OpenCode server-side template feature. The resolution flow is:

1. User types `/commandname args` in ChatInput
2. `session-ui-store.ts` `routeMessage` detects `/` prefix and calls `opencodeClient.sendCommand()`
3. `client.ts` `sendCommand()` calls `this.client.session.command()` from `@opencode-ai/sdk/v2`
4. The OpenCode server reads the command `.md` file, resolves `!`command`` patterns by executing shell commands, substitutes `$ARGUMENTS`, reads `@file` references, and sends the resolved prompt to the LLM
5. The LLM generates a response which streams back via SSE events
6. The chat bubble renders the LLM's response

The key issue: OpenChamber's `sendCommand()` at `packages/ui/src/lib/opencode/client.ts:935` discards the `session.command` response:

```typescript
unwrapSdkOptional(response, 'session.command');
return tempMessageId;
```

The response from `session.command` (return type `{ info: AssistantMessage; parts: Array<Part> }`) is ignored.

All rendering happens through SSE events. The `!`command`` template resolution is performed by the **external OpenCode server** — OpenChamber never sees the unresolved `!`command`` syntax.

## How to Reproduce

### Prerequisites
- OpenChamber running with a connected OpenCode server
- A command file at `~/.config/opencode/commands/push-merge.md` with the content below

### Command File Content
```yaml
---
description: Sync to remote target branch
---

Steps:
1. Run git pull origin $1
2. If conflict occurs, resolve it and write resolution to commit message
3. Run git push origin !`git branch --show-current`
4. Run git checkout $1
5. Run git merge !`git branch --show-current`
6. Run git push origin $1
7. Run git checkout !`git branch --show-current`
```

### Reproduction Steps
1. Create the command file at `~/.config/opencode/commands/push-merge.md`
2. Open OpenChamber
3. Type `/push-merge target-branch` in the chat input
4. Press Enter to send
5. **Observe**: The chat bubble shows the assistant's response. The `!`git branch --show-current`` resolved values (e.g., `main`, `feature/foo`) display as empty/blank in the rendered text.
6. **Verify**: Despite the display being empty, the actual git commands executed by the LLM use the correct branch name (execution works).

### Expected vs Actual

| Aspect | Expected | Actual |
|--------|----------|--------|
| Display in chat bubble | Resolved branch name (e.g., `main`) appears in the text | Blank/empty where resolved value should be |
| Backend execution | Command resolves correctly | Command resolves correctly |

## Relevant Code Files

| File | Role |
|------|------|
| `packages/ui/src/sync/session-ui-store.ts` (lines 74-166) | Slash command detection and routing |
| `packages/ui/src/lib/opencode/client.ts` (lines 900-937) | `sendCommand()` — sends command to OpenCode server |
| `packages/ui/src/components/chat/message/parts/ToolPart.tsx` (lines 841-936) | Bash tool output rendering |
| `packages/ui/src/components/chat/message/parts/AssistantTextPart.tsx` | Assistant text rendering |
| `packages/ui/src/components/chat/markdown/markdownCore.ts` | Markdown parsing (marked + remend) |

## Notes

- The `!`command`` resolution is entirely server-side (OpenCode server), not in OpenChamber
- The response from `session.command` API is discarded (`sendCommand` ignores the return value)
- The LLM's response (which uses the resolved values) is delivered via SSE events and rendered as text + tool parts
- The issue appears to be in how the OpenCode server communicates the resolved template back to OpenChamber for display
