/**
 * Reproduction script for issue #2323
 *
 * Problem: OpenChamber reads project `commands.start` from the legacy JSON file
 * `~/.local/share/opencode/storage/project/<id>.json`. In OpenCode 1.18.3,
 * project commands are stored in SQLite and exposed through the SDK API.
 * The legacy JSON often contains only worktree metadata (no commands.start),
 * so loadProjectStartCommand returns empty string and the project command is skipped.
 *
 * Run: node reproduce-2323.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Exact reproduction of the buggy loadProjectStartCommand from:
//   packages/web/server/lib/git/service.js  (line 1600)
//   packages/vscode/src/gitService.ts        (line 1376)
// ---------------------------------------------------------------------------

const getOpenCodeDataPath = () => {
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, 'opencode');
};

const loadProjectStartCommand = async (projectID) => {
  const storagePath = path.join(getOpenCodeDataPath(), 'storage', 'project', `${projectID}.json`);
  try {
    const raw = await fs.promises.readFile(storagePath, 'utf8');
    const parsed = JSON.parse(raw);
    const start = typeof parsed?.commands?.start === 'string' ? parsed.commands.start.trim() : '';
    return start || '';
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repro-2323-'));
// getOpenCodeDataPath() returns <xdgDataHome>/opencode, so storage dir must be
// <xdgDataHome>/opencode/storage/project/<id>.json
const opencodeDataDir = path.join(tmpDir, 'opencode');
const storageDir = path.join(opencodeDataDir, 'storage', 'project');
fs.mkdirSync(storageDir, { recursive: true });
process.env.XDG_DATA_HOME = tmpDir;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function writeProject(id, data) {
  fs.writeFileSync(path.join(storageDir, `${id}.json`), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Test 1: Legacy JSON with commands.start — should return the command
// ---------------------------------------------------------------------------
writeProject('test-1', {
  id: 'test-1',
  worktree: '/some/worktree',
  vcs: 'git',
  commands: { start: 'npm run setup' },
  sandboxes: [],
  time: { created: 1700000000000, updated: 1700000000000 },
});

await test('returns project start command when present in legacy JSON', async () => {
  const result = await loadProjectStartCommand('test-1');
  if (result !== 'npm run setup') {
    throw new Error(`Expected 'npm run setup', got '${result}'`);
  }
});

// ---------------------------------------------------------------------------
// Test 2: Legacy JSON WITHOUT commands.start — the core bug
//   In OpenCode 1.18.3, the legacy JSON often contains only worktree metadata.
//   This is the typical shape that OpenChamber itself writes (see updateProjectSandboxes).
// ---------------------------------------------------------------------------
writeProject('test-2', {
  id: 'test-2',
  worktree: '/some/worktree',
  vcs: 'git',
  sandboxes: ['/some/sandbox'],
  time: { created: 1700000000000, updated: 1700000000000 },
});

await test('legacy JSON lacks commands.start — returns empty (BUG)', async () => {
  const result = await loadProjectStartCommand('test-2');
  if (result !== '') {
    throw new Error(`Expected empty string, got '${result}'`);
  }
});

// ---------------------------------------------------------------------------
// Test 3: Legacy JSON with empty commands.start — explicit "run nothing"
// ---------------------------------------------------------------------------
writeProject('test-3', {
  id: 'test-3',
  worktree: '/some/worktree',
  commands: { start: '' },
  sandboxes: [],
  time: { created: 1700000000000, updated: 1700000000000 },
});

await test('commands.start explicitly empty — returns empty (correct)', async () => {
  const result = await loadProjectStartCommand('test-3');
  if (result !== '') {
    throw new Error(`Expected empty string, got '${result}'`);
  }
});

// ---------------------------------------------------------------------------
// Test 4: Legacy JSON file does not exist at all
// ---------------------------------------------------------------------------
await test('legacy JSON file missing — returns empty (fallback)', async () => {
  const result = await loadProjectStartCommand('nonexistent-project');
  if (result !== '') {
    throw new Error(`Expected empty string, got '${result}'`);
  }
});

// ---------------------------------------------------------------------------
// Show that the SDK alternative is available in OpenCode 1.18.3
// ---------------------------------------------------------------------------
console.log('');
console.log('── SDK alternative ──────────────────────────────────────────────');
console.log('');
console.log('The OpenCode SDK v2 (1.18.3) provides project data including commands');
console.log('through the project.current() API:');
console.log('');
console.log('  const project = await client.project.current({ directory });');
console.log('  // project.data.commands.start  ← includes the project start command');
console.log('');
console.log('The SDK Project type has `commands?: { start?: string }` alongside');
console.log('worktree, sandboxes, etc. This is the authoritative source in 1.18.3.');
console.log('');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`── Summary ──────────────────────────────────────────────────────`);
console.log(`Legacy JSON dir: ${storageDir}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log('');

if (failed > 0) {
  console.log('Reproduction encountered unexpected failures.');
  process.exit(1);
} else {
  console.log('Bug reproduced: loadProjectStartCommand fails to find commands.start');
  console.log('when the legacy JSON file lacks it (as in OpenCode 1.18.3).');
  console.log('');
  console.log('Root cause:');
  console.log('  1. loadProjectStartCommand only reads from legacy JSON file');
  console.log('     (' + path.join('{opencodeDataDir}', 'storage', 'project', '<id>.json') + ')');
  console.log('  2. OpenCode 1.18.3 stores commands.start in SQLite (opencode.db),');
  console.log('     not in the legacy JSON file');
  console.log('  3. The legacy JSON file is primarily written by updateProjectSandboxes(),');
  console.log('     which does NOT preserve commands.start from OpenCode project data');
  console.log('  4. SDK client.project.current() returns the full project incl. commands');
  console.log('');
  console.log('Fix suggestions from the issue:');
  console.log('  - Query the SDK project API first for commands.start');
  console.log('  - Fall back to legacy JSON for older OpenCode versions');
  console.log('  - Distinguish: "project not found" (try fallback) vs.');
  console.log('    "project commands.start = empty string" (run nothing)');
  console.log('');
  console.log('Affected files:');
  console.log('  - packages/web/server/lib/git/service.js  (loadProjectStartCommand, line 1600)');
  console.log('  - packages/vscode/src/gitService.ts        (loadProjectStartCommand, line 1376)');
}
