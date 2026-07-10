# Reproduction: Issue #2121 — Files tab fails with non-ASCII workspace paths

## Root Cause Analysis

The web server (`packages/web/server/index.js` line 6) imports `fs` from `'fs'`:

```javascript
import fs from 'fs';
```

In Electron, this resolves to the asar-patched filesystem module. When `fsPromises.realpath()`, `fsPromises.stat()`, `fsPromises.readdir()`, or `fsPromises.access()` is called on a path containing non-ASCII Unicode characters (e.g. Chinese characters), Electron's asar module has a known defect where it incorrectly constructs an `.asar` archive path from the Unicode-containing path, producing errors like:

```
Error: Invalid package D:\模板文件\app.asar
```

## Affected Code Paths

All of the following are in `packages/web/server/lib/fs/routes.js`:

### 1. `/api/fs/list` (line 1308) — Used by Files tab to list directory contents

```javascript
resolvedPath = await realpathCache.resolve(path.resolve(normalizeDirectoryPath(rawPath)));
```

The `realpathCache` is created at line 392 with `fsPromises.realpath.bind(fsPromises)` as the resolver. This calls asar-patched `realpath` on every list operation.

### 2. `/api/fs/stat` (line 727)

```javascript
const [canonicalPath, canonicalBase] = await Promise.all([
    fsPromises.realpath(resolved.resolved),
    fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
]);
```

### 3. `/api/fs/read` (lines 783-784)

```javascript
const [canonicalPath, canonicalBase] = await Promise.all([
    fsPromises.realpath(resolved.resolved),
    fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
]);
```

### 4. `/api/fs/raw` (lines 854-855)

Same pattern as read.

### 5. `/api/fs/serve` (lines 939-940)

Same pattern as read.

### 6. `/api/fs/write` (line 998)

```javascript
const writePath = await fsPromises.realpath(resolved.resolved).catch(...)
```

## Why This Happens

The `fsPromises` object in `packages/web/server/index.js` (line 214) comes from:

```javascript
const fsPromises = fs.promises;
```

Where `fs` is imported from `'fs'` (not `'node:fs'`). In Electron, this module is patched by the asar subsystem. The asar path-detection logic fails to correctly handle Unicode bytes in the path, causing it to:

1. Misidentify the user's workspace path as potentially containing an asar archive
2. Construct a path like `D:\模板文件\app.asar`
3. Report "Invalid package" when this path doesn't exist as a valid asar archive

## To Reproduce (Windows + Electron only)

1. Create a directory with non-ASCII characters: `mkdir D:\模板文件`
2. Place some files in it
3. Launch OpenChamber Electron app
4. Open `D:\模板文件` as the workspace
5. Click on the Files tab in the sidebar
6. Observe "Failed to fetch" error
7. Check `main.log` for:
   ```
   Error: Invalid package D:\模板文件\app.asar
   ```

## Workaround

Rename the workspace directory to use ASCII-only characters (per the issue reporter).

## Minimal Reproduction Script

See `reproduce-2121.mjs` — a Node.js script that exercises the exact code paths used by the Files tab and documents the Electron-aspect failure mode.
