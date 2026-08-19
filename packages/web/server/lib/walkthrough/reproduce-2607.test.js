import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Regression for https://github.com/openchamber/openchamber/issues/2607
// "[Bug] Why say so?" (walkthrough panel)
//
// Before the fix, a walkthrough small model whose provider had no usable login
// reported readiness ready:true, then generation returned HTTP 500 with the raw
// message `No OpenCode login found for provider "deepseek"` — shown in the
// error banner above the "No walkthrough yet" empty state.
//
// Direct-provider calls still refuse missing credentials. Walkthrough itself
// now delegates auth to OpenCode so plugin-backed providers can run.
// ---------------------------------------------------------------------------

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-2607-'));
process.env.HOME = TEMP_HOME;
process.env.OPENCHAMBER_DATA_DIR = path.join(TEMP_HOME, '.config', 'openchamber');

const CATALOG = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        family: 'deepseek-flash',
        limit: { context: 128_000 },
      },
    },
  },
};

vi.mock('../../opencode/models-metadata.js', () => ({
  getModelsMetadata: vi.fn(async () => ({ metadata: CATALOG, fromCache: false })),
}));

const SOURCE = { kind: 'working-tree', scope: 'all' };
const REPO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-2607-'));

const setupGitRepo = () => {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8' });
    } catch (error) {
      throw new Error(`git ${args.join(' ')} failed: ${error.stderr?.toString() ?? error.message}`);
    }
  };

  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(REPO_DIR, 'src'), { recursive: true });
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  run(['add', 'src/a.ts']);
  run(['commit', '-m', 'init']);
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf8');
};

let walkthrough;
let callSmallModel;

describe('issue 2607 — walkthrough blocks unauthenticated providers', () => {
  beforeAll(async () => {
    setupGitRepo();
    fs.writeFileSync(
      path.join(REPO_DIR, 'opencode.json'),
      JSON.stringify({ small_model: 'deepseek/deepseek-v4-flash' }, null, 2),
      'utf8',
    );

    walkthrough = await import('./index.js');
    callSmallModel = await import('../small-model/call.js');
  });

  afterAll(() => {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true });
    fs.rmSync(REPO_DIR, { recursive: true, force: true });
  });

  it('does not treat direct-provider login discovery as walkthrough authority', async () => {
    const result = await walkthrough.getWalkthrough({ directory: REPO_DIR, source: SOURCE });

    expect(result.readiness.ready).toBe(true);
    expect(result.readiness.model).toMatchObject({ providerID: 'deepseek', modelID: 'deepseek-v4-flash', hasLogin: false });
  });

  it('callSmallModel throws a structured no-provider-login error', async () => {
    const error = await callSmallModel.callSmallModel({
      auth: {},
      catalog: CATALOG,
      workingDirectory: REPO_DIR,
      providerID: 'deepseek',
      modelID: 'deepseek-v4-flash',
      prompt: 'x',
    }).then(() => null, (e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('No OpenCode login found for provider "deepseek"');
    expect(error.code).toBe('no-provider-login');
    expect(error.statusCode).toBe(401);
  });

});
