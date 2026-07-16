/**
 * Reproduction for issue #2273:
 * YAML files fail to send with "'file part media type application/octet-stream' functionality not supported"
 *
 * Root cause: YAML files (.yaml/.yml) are not recognized by the browser's MIME detection,
 * resulting in an empty MIME type. The `normalizeFilePart` method in client.ts does not
 * handle empty MIME types (via `shouldNormalizeToTextPlain`), so the empty MIME is sent
 * to the OpenCode SDK/server, which likely defaults it to `application/octet-stream` and
 * rejects it.
 */

import { describe, expect, test } from "bun:test";

/**
 * Replicates the logic from OpencodeClient.shouldNormalizeToTextPlain (client.ts:605)
 * to verify the behavior without needing to instantiate the full client.
 */
function shouldNormalizeToTextPlain(mime: string): boolean {
  if (!mime) return false;
  const lowerMime = mime.toLowerCase();
  if (lowerMime.startsWith('text/') && lowerMime !== 'text/plain') {
    return true;
  }
  const textBasedTypes = [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
    'application/yaml',
    'application/toml',
    'application/x-sh',
    'application/x-shellscript',
    'application/octet-stream',
    'image/svg+xml',
  ];
  return textBasedTypes.includes(lowerMime);
}

/**
 * Replicates the logic from OpencodeClient.normalizeFilePart (client.ts:700)
 */
async function normalizeFilePart(file: { mime: string; filename?: string; url: string }): Promise<{ mime: string; filename?: string; url: string }> {
  if (!shouldNormalizeToTextPlain(file.mime)) {
    return file;
  }

  let normalizedUrl = file.url;
  if (file.url.startsWith('data:')) {
    const commaIndex = file.url.indexOf(',');
    if (commaIndex !== -1) {
      const meta = file.url.substring(5, commaIndex);
      const content = file.url.substring(commaIndex);
      const newMeta = meta.replace(/^[^;,]+/, 'text/plain');
      normalizedUrl = `data:${newMeta}${content}`;
    }
  }

  return {
    mime: 'text/plain',
    filename: file.filename,
    url: normalizedUrl,
  };
}

describe("Issue #2273: YAML file upload MIME type handling", () => {
  // =========================================================================
  // Part 1: shouldNormalizeToTextPlain behavior
  // =========================================================================

  test("shouldNormalizeToTextPlain returns false for empty mime (root cause)", () => {
    // When a user uploads a YAML file via the browser's <input type="file">,
    // the browser's File.type is '' (empty string) because there's no standard
    // MIME type for YAML files. This empty string fails the `if (!mime) return false`
    // check and is not normalized.
    expect(shouldNormalizeToTextPlain("")).toBe(false);
    expect(shouldNormalizeToTextPlain("application/octet-stream")).toBe(true);
  });

  test("shouldNormalizeToTextPlain correctly handles known YAML MIME types", () => {
    // These are handled correctly
    expect(shouldNormalizeToTextPlain("application/x-yaml")).toBe(true);
    expect(shouldNormalizeToTextPlain("application/yaml")).toBe(true);
    // But the browser NEVER assigns these - it assigns '' (empty)
  });

  // =========================================================================
  // Part 2: normalizeFilePart behavior with real-world scenarios
  // =========================================================================

  test("normalizeFilePart returns unchanged file when mime is empty", async () => {
    // Simulates a YAML file uploaded from the browser
    const yamlFile = {
      mime: "",                    // Browser File.type for .yaml files
      filename: "config.yaml",
      url: "data:;base64,aGVsbG8=",  // Empty MIME in data URL
    };

    const result = await normalizeFilePart(yamlFile);

    // The mime stays empty! It should have been detected as YAML/text and
    // normalized to text/plain.
    expect(result.mime).toBe("");
    expect(result.mime).not.toBe("text/plain");
  });

  test("normalizeFilePart correctly normalizes application/octet-stream to text/plain", async () => {
    // Simulates a YAML file read through Electron's desktop_read_file
    // which falls back to application/octet-stream for unknown extensions
    const octetStreamFile = {
      mime: "application/octet-stream",
      filename: "config.yaml",
      url: "data:application/octet-stream;base64,aGVsbG8=",
    };

    const result = await normalizeFilePart(octetStreamFile);

    // This case IS handled correctly
    expect(result.mime).toBe("text/plain");
  });

  // =========================================================================
  // Part 3: MIME map gaps in Electron and VS Code runtimes
  // =========================================================================

  test("Electron main.mjs MIME map does not include .yaml or .yml extensions", () => {
    // From electron/main.mjs lines 3600-3620
    const electronMimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.js': 'text/javascript',
      '.ts': 'text/typescript',
      '.tsx': 'text/typescript-jsx',
      '.jsx': 'text/javascript-jsx',
      '.html': 'text/html',
      '.css': 'text/css',
      '.py': 'text/x-python',
    };

    const yamlExts = ['.yaml', '.yml'];
    for (const ext of yamlExts) {
      expect(electronMimeMap[ext] === undefined).toBe(true);
      // Falls back to 'application/octet-stream' — which IS handled by normalize,
      // but only if the path goes through the Electron file reader.
      const mimeFallback = electronMimeMap[ext] || 'application/octet-stream';
      expect(mimeFallback).toBe('application/octet-stream');
    }
  });

  test("VS Code bridge-fs-helpers-runtime.ts getFsMimeType does not include .yaml or .yml", () => {
    // From vscode/src/bridge-fs-helpers-runtime.ts lines 543-561
    const vscodeMimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.markdown': 'text/markdown; charset=utf-8',
      '.mmd': 'text/plain; charset=utf-8',
      '.mermaid': 'text/plain; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.pdf': 'application/pdf',
    };

    const yamlExts = ['.yaml', '.yml'];
    for (const ext of yamlExts) {
      expect(vscodeMimeMap[ext] === undefined).toBe(true);
    }
  });

  test("VS Code bridge-fs-helpers-runtime.ts guessMimeTypeFromExtension does not include .yaml or .yml", () => {
    // From vscode/src/bridge-fs-helpers-runtime.ts lines 17-39
    const guessMimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.log': 'text/plain',
      '.json': 'application/json',
      '.md': 'text/markdown',
      '.markdown': 'text/markdown',
    };

    const yamlExts = ['.yaml', '.yml'];
    for (const ext of yamlExts) {
      expect(guessMimeMap[ext] === undefined).toBe(true);
    }
  });

  // =========================================================================
  // Part 4: Input store flow
  // =========================================================================

  test("addAttachedFile stores browser's empty file.type for YAML files", () => {
    // This simulates what the browser provides when a user selects a .yaml file
    // via <input type="file"> — the browser File.type is empty for unknown types.
    const yamlFile = new File(["key: value\nfoo: bar\n"], "config.yaml", { type: "" });
    expect(yamlFile.type).toBe("");

    // In input-store.ts line 168:
    //   mimeType: file.type,
    // So the attached file gets mimeType: ''
    const attachedMimeType = yamlFile.type;
    expect(attachedMimeType).toBe("");

    // In session-ui-store.ts lines 1078-1083:
    //   mime: a.mimeType,
    // This becomes mime: '' which is not normalized (as shown above)
  });

  test("empty mime is not caught by shouldNormalizeToTextPlain guard", () => {
    // Key issue: the normalizeFilePart method at line 707 checks:
    //   if (!this.shouldNormalizeToTextPlain(file.mime)) { return file; }
    //
    // For mime='': shouldNormalizeToTextPlain returns false (line 606: if (!mime) return false)
    // So the file returns UNCHANGED with mime: '' — no normalization happens.
    //
    // Compare with mime='application/octet-stream': 
    // shouldNormalizeToTextPlain returns true → normalized to text/plain
    
    expect(shouldNormalizeToTextPlain("")).toBe(false);
    expect(shouldNormalizeToTextPlain("application/octet-stream")).toBe(true);
    
    // The gap: empty mime (from browser File.type) is never mapped to text/plain,
    // nor is the filename extension checked to infer the correct MIME type.
  });
});
