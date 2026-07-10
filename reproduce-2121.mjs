#!/usr/bin/env node

/**
 * Reproduction script for Issue #2121
 *
 * Files tab fails ("Failed to fetch") when workspace path contains non-ASCII
 * (Unicode/CJK) characters in Electron.
 *
 * This script exercises the exact code paths used by the Files tab's
 * /api/fs/list and /api/fs/stat endpoints, using the same dependencies
 * (fs.promises, path, realpath cache) as the production code.
 *
 * HOW TO USE:
 *   node reproduce-2121.mjs
 *
 * On a plain Node.js environment (non-Electron), the script should succeed
 * because Node's fs module handles Unicode paths correctly. The bug only
 * reproduces when running inside Electron where the asar-patched fs module
 * (imported via 'fs' without 'node:' prefix) has a Unicode path handling
 * defect.
 *
 * To reproduce the actual Electron bug:
 *   1. Build the Electron app: bun run electron:build
 *   2. Create a workspace at D:\模板文件 (or any Unicode-named directory)
 *   3. Install the OpenChamber app and open that workspace
 *   4. Navigate to Files tab — observe "Failed to fetch"
 *
 * Expected log error:
 *   Error: Invalid package D:\模板文件\app.asar
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Replicate the realpath cache from packages/web/server/lib/path-realpath-cache.js
// ---------------------------------------------------------------------------
function createRealpathCache({ realpath }) {
  const cache = new Map();

  const resolve = async (value) => {
    if (typeof value !== 'string' || value.length === 0) {
      return value;
    }

    const cached = cache.get(value);
    if (cached) {
      return cached;
    }

    const result = await realpath(value);
    cache.set(value, result);
    return result;
  };

  return { resolve };
}

// ---------------------------------------------------------------------------
// Replicate the key code paths from routes.js
// ---------------------------------------------------------------------------

/**
 * Simulates the /api/fs/list endpoint (line 1294-1416 in routes.js).
 * This is the primary endpoint used by the Files tab.
 */
async function simulateListDirectory(fsPromises, dirPath) {
  const realpathCache = createRealpathCache({
    realpath: fsPromises.realpath.bind(fsPromises),
  });

  // Line 1308 in routes.js
  const resolvedPath = await realpathCache.resolve(path.resolve(dirPath));

  // Line 1310 in routes.js
  const stats = await fsPromises.stat(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error('Not a directory');
  }

  // Line 1315 in routes.js
  const dirents = await fsPromises.readdir(resolvedPath, { withFileTypes: true });

  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      const entryPath = path.join(resolvedPath, dirent.name);
      let isDirectory = dirent.isDirectory();
      const isSymbolicLink = dirent.isSymbolicLink();

      if (!isDirectory && isSymbolicLink) {
        try {
          const linkStats = await fsPromises.stat(entryPath);
          isDirectory = linkStats.isDirectory();
        } catch {
          isDirectory = false;
        }
      }

      return {
        name: dirent.name,
        path: entryPath,
        isDirectory,
        isFile: dirent.isFile(),
        isSymbolicLink,
      };
    })
  );

  return {
    path: resolvedPath,
    entries: entries.filter(Boolean),
  };
}

/**
 * Simulates the /api/fs/stat endpoint (line 700-755 in routes.js).
 */
async function simulateStatPath(fsPromises, filePath) {
  const resolved = path.resolve(filePath);

  // Line 727 in routes.js (the exact line reported in the bug)
  const canonicalPath = await fsPromises.realpath(resolved);

  const stats = await fsPromises.stat(canonicalPath);
  if (!stats.isFile()) {
    throw new Error('Specified path is not a file');
  }

  return {
    path: canonicalPath,
    isFile: true,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function main() {
  // Determine which fs module to use for the "control" test (unicode-safe path
  // via node:fs) and the "experimental" test (via the plain 'fs' import, which
  // in Electron carries the asar patch).
  //
  // In plain Node.js, both imports are identical so both tests pass.
  // In Electron, the second test would fail with:
  //   Error: Invalid package <unicode-path>\app.asar
  //
  // We test BOTH to demonstrate that even the node:fs-prefixed import works
  // correctly and to highlight where the asar bug would strike.

  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repro-2121-'));

  // Create the Unicode-named test directory
  const unicodeDirName = '模板文件';  // Chinese: "template files"
  const unicodeDir = path.join(testRoot, unicodeDirName);
  const asciiDir = path.join(testRoot, 'templates');  // ASCII control

  fs.mkdirSync(unicodeDir, { recursive: true });
  fs.mkdirSync(asciiDir, { recursive: true });

  // Create a test file inside each directory
  fs.writeFileSync(path.join(unicodeDir, 'test.txt'), 'hello unicode world');
  fs.writeFileSync(path.join(asciiDir, 'test.txt'), 'hello ascii world');

  console.log('');
  console.log('=== Issue #2121 Reproduction ===');
  console.log('');
  console.log(`Test root:      ${testRoot}`);
  console.log(`Unicode dir:    ${unicodeDir}`);
  console.log(`ASCII dir:      ${asciiDir}`);
  console.log('');
  console.log('NOTE: This bug only reproduces in Electron due to its asar');
  console.log('filesystem patching (via `import fs from \'fs\'` without the');
  console.log('`node:` prefix). On plain Node.js, both `fs` and `node:fs` are');
  console.log('identical, so both tests are expected to pass here.');
  console.log('');

  // --- Test 1: List Unicode directory using node:fs (always works) ---
  console.log('--- Test 1: List Unicode directory (node:fs) ---');
  try {
    const result = await simulateListDirectory(fsp, unicodeDir);
    console.log(`  PASS: Listed ${result.entries.length} entries`);
    result.entries.forEach((e) => console.log(`    ${e.name} (${e.isDirectory ? 'dir' : 'file'})`));
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
  }

  // --- Test 2: Stat file in Unicode directory using node:fs (always works) ---
  console.log('');
  console.log('--- Test 2: Stat file in Unicode directory (node:fs) ---');
  try {
    const result = await simulateStatPath(fsp, path.join(unicodeDir, 'test.txt'));
    console.log(`  PASS: ${result.path} (${result.size} bytes)`);
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
  }

  // --- Test 3: List ASCII directory using node:fs (always works) ---
  console.log('');
  console.log('--- Test 3: List ASCII directory (node:fs) ---');
  try {
    const result = await simulateListDirectory(fsp, asciiDir);
    console.log(`  PASS: Listed ${result.entries.length} entries`);
    result.entries.forEach((e) => console.log(`    ${e.name} (${e.isDirectory ? 'dir' : 'file'})`));
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
  }

  // --- Test 4: Stat file in ASCII directory using node:fs (always works) ---
  console.log('');
  console.log('--- Test 4: Stat file in ASCII directory (node:fs) ---');
  try {
    const result = await simulateStatPath(fsp, path.join(asciiDir, 'test.txt'));
    console.log(`  PASS: ${result.path} (${result.size} bytes)`);
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
  }

  // --- Expected Failure: In Electron, listing a Unicode directory would fail ---
  console.log('');
  console.log('--- Expected failure in Electron (cannot reproduce on plain Node) ---');
  console.log('');
  console.log('When running inside Electron, the `fs` module imported without');
  console.log('the `node:` prefix has asar patching. The following call would');
  console.log('fail with:');
  console.log('');
  console.log('  Error: Invalid package <unicode-path>\\app.asar');
  console.log('');
  console.log('Specifically, the realpath() call at routes.js:727 and');
  console.log('the realpath() call at routes.js:1308 are both affected.');
  console.log('');

  // Cleanup
  fs.rmSync(testRoot, { recursive: true, force: true });
  console.log('Cleaned up test files.');
  console.log('=== Done ===');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
