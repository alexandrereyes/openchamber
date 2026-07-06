import { describe, expect, it } from 'vitest';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import { getAgentSources } from './agents.js';

/**
 * Reproduction of GitHub issue #2066:
 * "Agents coming from no where and cannot delete them"
 *
 * Root cause: A mismatch between client-side and server-side deletability checks.
 *
 * - Client-side check (`isAgentBuiltIn` in useAgentsStore.ts):
 *   Only checks the SDK's `builtIn` / `native` boolean properties from the
 *   OpenCode server's `/agent` endpoint response.
 *
 * - Server-side check (`deleteAgent` in agents.js):
 *   Searches for backing `.md` files (in AGENT_DIR / .opencode/agents/) or
 *   JSON config entries (in opencode.json). If none found, throws:
 *   "Agent ${name} is built-in or not deletable"
 *
 * The OpenCode server can return agents via `/agent` that have:
 *   `builtIn: false` / `native: false` (so the client shows a delete button)
 *   BUT no `.md` file or JSON config entry on disk (so the server cannot delete them)
 *
 * This happens when:
 * - Agents are loaded by OpenCode from plugins, native extensions, or other
 *   sources that don't create backing files in the expected locations.
 * - The OpenCode server is external (OPENCODE_HOST) and its agent list differs
 *   from the local file system.
 */

describe('Issue #2066 - Agents without backing files appear deletable but cannot be deleted', () => {

  /**
   * Scenario: An agent that exists in OpenCode's /agent response (with
   * builtIn: false) but has no backing .md file or JSON config entry on disk.
   *
   * The client shows a delete button because isAgentBuiltIn() returns false
   * (native !== true, builtIn !== true).
   *
   * But deleteAgent() will fail because no .md file or JSON entry exists.
   *
   * This test verifies that getAgentSources() correctly reports no sources
   * for such an agent, which means the server will reject deletion.
   */
  it('getAgentSources returns no sources for an agent without backing files', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-repro-2066-'));

    try {
      const agentName = 'unknown-plugin-agent';

      // Create an empty project directory. No .md files, no opencode.json.
      const projectDir = path.join(tempRoot, 'my-project');
      await fsPromises.mkdir(projectDir, { recursive: true });

      // Simulate what happens when OpenCode returns an agent that has no
      // backing files — e.g. from a plugin that registers agents with OpenCode
      // but doesn't create .md files in the expected directories.

      const sources = getAgentSources(agentName, projectDir);

      // The server-side route /api/config/agents/:name computes:
      //   isBuiltIn: !sources.md.exists && !sources.json.exists
      // For this agent, both are false → isBuiltIn: true
      expect(sources.md.exists).toBe(false);
      expect(sources.json.exists).toBe(false);

      // This is correct server-side behavior — the agent has no backing files.
      // But the CLIENT side doesn't read this sources data; it only checks
      // the SDK's `builtIn` / `native` property.

      console.log(
        `[Repro] Agent "${agentName}" has md.exists=${sources.md.exists}, json.exists=${sources.json.exists}.`,
        `The route handler would set isBuiltIn=true, meaning the server CANNOT delete it.`,
      );
      console.log(
        `[Repro] However, if OpenCode returns this agent with builtIn=false or native=false,`,
        `the client WILL show a delete button (isAgentBuiltIn returns false).`,
        `Clicking delete will cause the server to throw "Agent ${agentName} is built-in or not deletable".`,
      );
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  /**
   * Scenario: An agent WITH a backing .md file. This works correctly.
   * Demonstrates that the server CAN delete agents that have files.
   */
  it('getAgentSources returns sources for an agent with a backing .md file (control test)', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-repro-2066-ok-'));

    try {
      const agentName = 'my-agent';
      const projectDir = path.join(tempRoot, 'my-project');
      const agentsDir = path.join(projectDir, '.opencode', 'agents');
      await fsPromises.mkdir(agentsDir, { recursive: true });

      // Create an agent .md file (simulating a user-created agent)
      const agentMdPath = path.join(agentsDir, `${agentName}.md`);
      await fsPromises.writeFile(agentMdPath, `---\ntemperature: 0.7\nmode: primary\n---\n\nYou are an agent.`);

      const sources = getAgentSources(agentName, projectDir);

      // Agent has a backing .md file → server CAN delete it
      expect(sources.md.exists).toBe(true);
      expect(sources.md.path).toBe(agentMdPath);

      console.log(
        `[Repro] Agent "${agentName}" with backing .md file: md.exists=${sources.md.exists}.`,
        `Server CAN delete this agent. ✔`
      );
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  /**
   * Scenario: An agent defined only in opencode.json (no .md file).
   * This should also be deletable since the JSON config entry can be removed.
   */
  it('getAgentSources returns sources for an agent defined in opencode.json', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-repro-2066-json-'));

    try {
      const agentName = 'json-agent';
      const projectDir = path.join(tempRoot, 'my-project');
      await fsPromises.mkdir(projectDir, { recursive: true });

      // Create an opencode.json with an agent entry (no .md file)
      const configPath = path.join(projectDir, 'opencode.json');
      await fsPromises.writeFile(configPath, JSON.stringify({
        agent: {
          [agentName]: {
            mode: 'subagent',
            model: 'gpt-4',
          }
        }
      }, null, 2));

      const sources = getAgentSources(agentName, projectDir);

      // Agent has JSON config entry → server CAN delete it
      expect(sources.md.exists).toBe(false);
      expect(sources.json.exists).toBe(true);

      console.log(
        `[Repro] Agent "${agentName}" with JSON config entry: json.exists=${sources.json.exists}.`,
        `Server CAN delete this agent. ✔`
      );
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  /**
   * Demonstrate the exact mismatch that causes the bug.
   *
   * The OpenCode server's /agent endpoint can return agents with:
   *   {
   *     name: "plugin-agent",
   *     builtIn: false,
   *     native: false,
   *     // ... other properties
   *   }
   *
   * The client's isAgentBuiltIn() returns false for this agent,
   * so a delete button is shown.
   *
   * But the server's deleteAgent() will throw because no .md file
   * or JSON config entry exists for this agent.
   *
   * The screenshot in the issue shows the error toast:
   * "This agent could not be deleted because its definition was not found."
   * which matches the error handling in AgentsSidebar.tsx line 203-206:
   *
   *   const definitionMissing = /built-in|not deletable|not found/i.test(message);
   */
  it('demonstrates the mismatch: SDK native=false but no backing files', () => {
    // Simulate the OpenCode SDK Agent shape that triggers the bug
    const agentFromOpenCodeServer = {
      name: 'mystery-plugin-agent',
      mode: 'subagent',
      builtIn: false,   // ← the SDK Agent type has this as required
      native: false,     // ← v2 Agent type also has this as optional
      // No backing .md file or JSON entry exists on disk
    };

    // Client-side check (useAgentsStore.ts isAgentBuiltIn):
    // export const isAgentBuiltIn = (agent: Agent): boolean => {
    //   const extended = agent as AgentWithExtras & { builtIn?: boolean };
    //   return extended.native === true || extended.builtIn === true;
    // };
    const isAgentBuiltInClient = (agent) => {
      return agent.native === true || agent.builtIn === true;
    };

    // This agent is NOT considered built-in by the client → delete button shown
    const clientSaysBuiltIn = isAgentBuiltInClient(agentFromOpenCodeServer);
    expect(clientSaysBuiltIn).toBe(false);

    console.log(
      `[Repro] Agent "${agentFromOpenCodeServer.name}": ` +
      `client isAgentBuiltIn() returns ${clientSaysBuiltIn} ` +
      `(native=${agentFromOpenCodeServer.native}, builtIn=${agentFromOpenCodeServer.builtIn}). ` +
      `→ Client shows DELETE button.`
    );

    // Server-side check: getAgentSources returns { md: { exists: false }, json: { exists: false } }
    // So the server's /api/config/agents/:name would return { isBuiltIn: true }
    // And deleteAgent() would throw because no backing files exist.

    console.log(
      `[Repro] Server-side: getAgentSources() would return { md.exists: false, json.exists: false }. ` +
      `→ Server reports isBuiltIn=true, deleteAgent() throws.`
    );
    console.log('');
    console.log('[Repro] === MISMATCH DETECTED ===');
    console.log('[Repro] Client says: NOT built-in → show delete button');
    console.log('[Repro] Server says: Built-in (no files) → cannot delete');
    console.log('[Repro] ========================');
    console.log('');
    console.log('[Repro] Root cause: The client determines deletability from the SDK\'s builtIn/native');
    console.log('[Repro] property, but the server determines deletability by checking for backing');
    console.log('[Repro] .md files or JSON config entries on disk. These two sources of truth');
    console.log('[Repro] can disagree when OpenCode returns agents from plugins/extensions that');
    console.log('[Repro] don\'t create files in the expected directories.');
  });
});
