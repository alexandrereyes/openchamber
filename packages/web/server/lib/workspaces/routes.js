import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_PATCH_BYTES = 20 * 1024 * 1024;
const WORKSPACE_PLUGIN_PACKAGE = '@openchamber/opencode-container-workspace';
const WORKSPACE_PLUGIN_RESOURCE_PATH = path.join('opencode-container-workspace', 'src', 'plugin.js');
const EXPORT_DIFF_COMMAND = 'tmp=$(mktemp); idx=$(git rev-parse --git-path index 2>/dev/null || true); if [ -n "$idx" ] && [ -f "$idx" ]; then cp "$idx" "$tmp"; fi; GIT_INDEX_FILE="$tmp" git add -N . >/dev/null 2>&1 || true; GIT_INDEX_FILE="$tmp" git diff --binary HEAD; code=$?; rm -f "$tmp"; exit $code';

export function resolveWorkspacePluginSpec(options = {}) {
  const env = options.env ?? process.env;
  const explicit = typeof env.OPENCHAMBER_WORKSPACE_PLUGIN_PATH === 'string'
    ? env.OPENCHAMBER_WORKSPACE_PLUGIN_PATH.trim()
    : '';
  if (explicit) return explicit;

  const resolved = fileURLToPath(options.resolvedSpecUrl ?? import.meta.resolve(WORKSPACE_PLUGIN_PACKAGE));
  if (!resolved.includes('.asar')) return resolved;

  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const resourceCandidate = resourcesPath
    ? path.join(resourcesPath, WORKSPACE_PLUGIN_RESOURCE_PATH)
    : '';
  if (resourceCandidate && fs.existsSync(resourceCandidate)) return resourceCandidate;

  const unpackedCandidate = resolved.replace(/\.asar([/\\])/, '.asar.unpacked$1');
  if (unpackedCandidate !== resolved && fs.existsSync(unpackedCandidate)) return unpackedCandidate;

  throw new Error('Secure workspace plugin is inside app.asar and no unpacked plugin resource is available');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnCommand = options.spawn ?? spawn;
    const child = spawnCommand(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out`));
    }, options.timeoutMs ?? 30_000);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(stderr || stdout || `${command} failed with ${code}`);
      error.status = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function normalizePatch(value) {
  if (typeof value !== 'string') return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_PATCH_BYTES) return null;
  return value;
}

function summarizePatch(patch) {
  const files = new Map();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    const path = match?.[2] ?? match?.[1];
    if (path) files.set(path, { path, additions: 0, deletions: 0 });
  }
  let current = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      current = match?.[2] ? files.get(match[2]) : null;
      continue;
    }
    if (!current || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) current.additions += 1;
    if (line.startsWith('-')) current.deletions += 1;
  }
  const items = [...files.values()];
  return {
    files: items,
    totalFiles: items.length,
    additions: items.reduce((sum, item) => sum + item.additions, 0),
    deletions: items.reduce((sum, item) => sum + item.deletions, 0),
  };
}

async function validateDocker() {
  await run('docker', ['info'], { timeoutMs: 15_000 });
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 }).catch(() => ({ stdout: '' }));
  return { available: true, version: version.stdout.trim() || null };
}

async function validateKubernetes({ context, namespace }) {
  const base = context ? ['--context', context] : [];
  const targetNamespace = namespace || 'default';
  await run('kubectl', [...base, 'version', '--client=true'], { timeoutMs: 15_000 });
  for (const [verb, resource] of requiredKubernetesPermissions()) {
    await run('kubectl', [...base, 'auth', 'can-i', verb, resource, '-n', targetNamespace], { timeoutMs: 15_000 });
  }
  return { available: true, context: context || null, namespace: targetNamespace };
}

function requiredKubernetesPermissions() {
  return [
    ['get', 'pods'],
    ['list', 'pods'],
    ['watch', 'pods'],
    ['create', 'pods/exec'],
    ['create', 'pods/portforward'],
    ['create', 'secrets'],
    ['get', 'secrets'],
    ['patch', 'secrets'],
    ['delete', 'secrets'],
    ['create', 'persistentvolumeclaims'],
    ['get', 'persistentvolumeclaims'],
    ['patch', 'persistentvolumeclaims'],
    ['delete', 'persistentvolumeclaims'],
    ['create', 'deployments.apps'],
    ['get', 'deployments.apps'],
    ['patch', 'deployments.apps'],
    ['delete', 'deployments.apps'],
    ['create', 'services'],
    ['get', 'services'],
    ['patch', 'services'],
    ['delete', 'services'],
  ];
}

function readWorkspaceSettings(settings) {
  return {
    enabled: settings?.secureWorkspacesEnabled === true,
    defaultProvider: settings?.secureWorkspacesDefaultProvider === 'kubernetes' ? 'kubernetes' : 'docker',
    image: typeof settings?.secureWorkspacesImage === 'string' && settings.secureWorkspacesImage.trim()
      ? settings.secureWorkspacesImage.trim()
      : 'ghcr.io/openchamber/opencode-workspace:1.0.0',
    requirePinnedImage: settings?.secureWorkspacesRequirePinnedImage !== false,
    kubernetesContext: typeof settings?.secureWorkspacesKubernetesContext === 'string' ? settings.secureWorkspacesKubernetesContext.trim() : '',
    kubernetesNamespace: typeof settings?.secureWorkspacesKubernetesNamespace === 'string' && settings.secureWorkspacesKubernetesNamespace.trim()
      ? settings.secureWorkspacesKubernetesNamespace.trim()
      : 'openchamber-workspaces',
  };
}

function buildPluginOptions(settings) {
  return {
    defaultImage: settings.image,
    allowedImages: [settings.image],
    requirePinnedImage: settings.requirePinnedImage,
    defaultProvider: settings.defaultProvider,
    kubernetes: {
      context: settings.kubernetesContext || undefined,
      namespace: settings.kubernetesNamespace,
    },
  };
}

function isWorkspacePluginEntry(entry, pluginSpec) {
  return (Boolean(pluginSpec) && entry?.spec === pluginSpec)
    || entry?.spec === WORKSPACE_PLUGIN_PACKAGE
    || (typeof entry?.spec === 'string' && (
      entry.spec.includes('opencode-container-workspace')
      || entry.spec.includes('opencode-workspace-plugin')
    ));
}

async function loadOpenCodeWorkspace({ id, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders }) {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await fetch(buildOpenCodeUrl(`/experimental/workspace${query}`, ''), {
    headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
  });
  if (!response.ok) {
    throw new Error(`Failed to list OpenCode workspaces: ${response.statusText}`);
  }
  const workspaces = await response.json();
  if (!Array.isArray(workspaces)) throw new Error('OpenCode returned an invalid workspace list');
  const workspace = workspaces.find((item) => item?.id === id);
  if (!workspace) throw new Error('Workspace not found');
  return workspace;
}

function readWorkspaceExtra(workspace) {
  const extra = workspace?.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new Error('Workspace is missing provider metadata');
  }
  return extra;
}

async function exportWorkspaceDiff(workspace, spawnCommand) {
  const extra = readWorkspaceExtra(workspace);
  if (extra.provider === 'docker') {
    const container = extra.runtime?.container;
    if (!container) throw new Error('Docker workspace metadata is missing container name');
    const { stdout } = await run('docker', ['exec', container, 'sh', '-lc', EXPORT_DIFF_COMMAND], { timeoutMs: 60_000, spawn: spawnCommand });
    return { patch: stdout, provider: 'docker' };
  }
  if (extra.provider === 'kubernetes') {
    const deployment = extra.runtime?.deployment;
    const namespace = extra.runtime?.namespace;
    if (!deployment || !namespace) throw new Error('Kubernetes workspace metadata is missing deployment or namespace');
    const contextArgs = extra.policy?.kubernetes?.context ? ['--context', extra.policy.kubernetes.context] : [];
    const { stdout } = await run('kubectl', [
      ...contextArgs,
      'exec', `deployment/${deployment}`, '-n', namespace, '--', 'sh', '-lc', EXPORT_DIFF_COMMAND,
    ], { timeoutMs: 60_000, spawn: spawnCommand });
    return { patch: stdout, provider: 'kubernetes' };
  }
  throw new Error(`Unsupported workspace provider: ${extra.provider ?? '<unknown>'}`);
}

export function registerWorkspaceRoutes(app, dependencies) {
  const {
    validateDirectoryPath,
    readSettingsFromDiskMigrated,
    refreshOpenCodeAfterConfigChange,
    listPluginEntries,
    createPluginEntry,
    updatePluginEntry,
    deletePluginEntry,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    spawn: spawnCommand = spawn,
    workspacePluginSpec,
    resolveWorkspacePluginSpec: resolvePluginSpec = resolveWorkspacePluginSpec,
  } = dependencies;

  app.get('/api/workspaces/providers/validate', async (req, res) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : '';
    try {
      if (provider === 'docker') {
        return res.json(await validateDocker());
      }
      if (provider === 'kubernetes') {
        return res.json(await validateKubernetes({
          context: typeof req.query.context === 'string' ? req.query.context : undefined,
          namespace: typeof req.query.namespace === 'string' ? req.query.namespace : undefined,
        }));
      }
      return res.status(400).json({ available: false, error: 'Unsupported workspace provider' });
    } catch (error) {
      return res.status(503).json({
        available: false,
        error: error instanceof Error ? error.message : 'Workspace provider is unavailable',
      });
    }
  });

  app.post('/api/workspaces/export/summary', async (req, res) => {
    const patch = normalizePatch(req.body?.patch);
    if (patch === null) return res.status(400).json({ error: 'Patch is required and must be under 20MB' });
    return res.json({ patchBytes: Buffer.byteLength(patch, 'utf8'), summary: summarizePatch(patch) });
  });

  app.get('/api/workspaces/:id/export-diff', async (req, res) => {
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      const workspace = await loadOpenCodeWorkspace({
        id: req.params.id,
        directory,
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
      });
      const result = await exportWorkspaceDiff(workspace, spawnCommand);
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to export workspace diff' });
    }
  });

  app.post('/api/workspaces/export/apply', async (req, res) => {
    const patch = normalizePatch(req.body?.patch);
    const directory = typeof req.body?.directory === 'string' ? req.body.directory : '';
    const checkOnly = req.body?.checkOnly !== false;
    if (patch === null) return res.status(400).json({ error: 'Patch is required and must be under 20MB' });
    const validation = await validateDirectoryPath(directory);
    if (!validation.ok) return res.status(400).json({ error: validation.error || 'Invalid directory' });
    try {
      await run('git', ['apply', '--check', '-'], { cwd: validation.directory, input: patch, timeoutMs: 60_000, spawn: spawnCommand });
      if (!checkOnly) {
        await run('git', ['apply', '-'], { cwd: validation.directory, input: patch, timeoutMs: 60_000, spawn: spawnCommand });
      }
      return res.json({ applied: !checkOnly, checkOnly, summary: summarizePatch(patch) });
    } catch (error) {
      return res.status(409).json({
        applied: false,
        checkOnly,
        error: error instanceof Error ? error.message : 'Patch cannot be applied cleanly',
      });
    }
  });

  app.post('/api/workspaces/configure', async (_req, res) => {
    try {
      const settings = readWorkspaceSettings(await readSettingsFromDiskMigrated());
      const entries = listPluginEntries(null);
      if (!settings.enabled) {
        const existingEntries = entries.filter((entry) => isWorkspacePluginEntry(entry, null));
        for (const existing of existingEntries) {
          deletePluginEntry(existing.id, null);
        }
        if (existingEntries.length > 0) {
          await refreshOpenCodeAfterConfigChange('secure workspaces disabled');
        }
        return res.json({ configured: false, enabled: false });
      }

      const pluginSpec = workspacePluginSpec ?? resolvePluginSpec();
      const existing = entries.find((entry) => isWorkspacePluginEntry(entry, pluginSpec));
      const entry = {
        spec: pluginSpec,
        scope: 'user',
        options: buildPluginOptions(settings),
      };
      if (existing) updatePluginEntry(existing.id, entry, null);
      else createPluginEntry(entry, null);
      await refreshOpenCodeAfterConfigChange('secure workspaces configured');
      return res.json({ configured: true, enabled: true, spec: pluginSpec });
    } catch (error) {
      console.error('[API:POST /api/workspaces/configure] Failed:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to configure secure workspaces' });
    }
  });
}
