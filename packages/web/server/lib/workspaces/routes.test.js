import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.fn();

const { registerWorkspaceRoutes, resolveWorkspacePluginSpec } = await import('./routes.js');
const originalFetch = globalThis.fetch;

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const createChild = ({ stdout = '', stderr = '', code = 0 } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  setTimeout(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  }, 0);
  return child;
};

const createDependencies = (overrides = {}) => ({
  validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
  readSettingsFromDiskMigrated: vi.fn(async () => ({ secureWorkspacesEnabled: true })),
  refreshOpenCodeAfterConfigChange: vi.fn(async () => undefined),
  listPluginEntries: vi.fn(() => []),
  createPluginEntry: vi.fn(),
  updatePluginEntry: vi.fn(),
  deletePluginEntry: vi.fn(),
  buildOpenCodeUrl: vi.fn((route) => `http://opencode.test${route}`),
  getOpenCodeAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test' })),
  spawn: spawnMock,
  ...overrides,
});

describe('workspace routes', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('configures OpenCode with an absolute installed plugin path', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      workspacePluginSpec: '/real/plugin/src/plugin.js',
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        secureWorkspacesEnabled: true,
        secureWorkspacesDefaultProvider: 'docker',
        secureWorkspacesImage: 'ghcr.io/openchamber/opencode-workspace:1.0.0',
      })),
    });
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/configure')({}, res);

    expect(res.statusCode).toBe(200);
    expect(deps.createPluginEntry).toHaveBeenCalledTimes(1);
    const entry = deps.createPluginEntry.mock.calls[0][0];
    expect(path.isAbsolute(entry.spec)).toBe(true);
    expect(entry.spec).toBe('/real/plugin/src/plugin.js');
    expect(entry.options.defaultProvider).toBe('docker');
  });

  it('disables secure workspaces without resolving a missing plugin path', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      readSettingsFromDiskMigrated: vi.fn(async () => ({ secureWorkspacesEnabled: false })),
      resolveWorkspacePluginSpec: vi.fn(() => {
        throw new Error('plugin resource missing');
      }),
      listPluginEntries: vi.fn(() => [{
        id: 'plugin-1',
        spec: '/Applications/OpenChamber.app/Contents/Resources/app.asar/node_modules/@openchamber/opencode-container-workspace/src/plugin.js',
      }]),
    });
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/configure')({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ configured: false, enabled: false });
    expect(deps.resolveWorkspacePluginSpec).not.toHaveBeenCalled();
    expect(deps.deletePluginEntry).toHaveBeenCalledWith('plugin-1', null);
  });

  it('resolves an explicit plugin path override before module resolution', () => {
    expect(resolveWorkspacePluginSpec({
      env: { OPENCHAMBER_WORKSPACE_PLUGIN_PATH: '/custom/plugin.js' },
      resolvedSpecUrl: 'file:///app/app.asar/node_modules/@openchamber/opencode-container-workspace/src/plugin.js',
    })).toBe('/custom/plugin.js');
  });

  it('resolves app.asar plugin paths to unpacked Electron resources', () => {
    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-workspaces-'));
    const pluginPath = path.join(resourcesDir, 'opencode-container-workspace', 'src', 'plugin.js');
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, 'export default {}\n');
    try {
      const resolved = resolveWorkspacePluginSpec({
        env: {},
        resourcesPath: resourcesDir,
        resolvedSpecUrl: 'file:///Applications/OpenChamber.app/Contents/Resources/app.asar/node_modules/@openchamber/opencode-container-workspace/src/plugin.js',
      });
      expect(resolved).toBe(pluginPath);
    } finally {
      fs.rmSync(resourcesDir, { recursive: true, force: true });
    }
  });

  it('exports docker diffs with a temporary index that includes untracked files', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        id: 'ws-1',
        extra: { provider: 'docker', runtime: { container: 'openchamber-ws-1' } },
      }],
    }));
    spawnMock.mockReturnValue(createChild({ stdout: 'diff --git a/new.txt b/new.txt\n' }));

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/:id/export-diff')({ params: { id: 'ws-1' }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.patch).toContain('diff --git');
    const [, args] = spawnMock.mock.calls[0];
    const script = args.at(-1);
    expect(script).toContain('GIT_INDEX_FILE="$tmp" git add -N .');
    expect(script).toContain('git diff --binary HEAD');
  });

  it('returns apply check failures as conflicts without applying the patch', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    spawnMock.mockReturnValue(createChild({ stderr: 'patch does not apply', code: 1 }));

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/export/apply')({
      body: { directory: '/repo', patch: 'diff --git a/a b/a\n', checkOnly: false },
    }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.applied).toBe(false);
    expect(res.body.error).toContain('patch does not apply');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('checks then applies when patch validation succeeds and checkOnly is false', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    spawnMock.mockImplementation(() => createChild());

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/export/apply')({
      body: { directory: '/repo', patch: 'diff --git a/a b/a\n', checkOnly: false },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][1]).toEqual(['apply', '--check', '-']);
    expect(spawnMock.mock.calls[1][1]).toEqual(['apply', '-']);
  });
});
