import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readPolicy, SECURE_DOCKER_NETWORK } from '../policy.js';
import { createDockerProvider } from './docker.js';

const image = process.env.OPENCHAMBER_DOCKER_WORKSPACE_INTEGRATION_IMAGE;
const httpProxy = process.env.OPENCHAMBER_DOCKER_WORKSPACE_INTEGRATION_HTTP_PROXY;
const integrationIt = image && httpProxy ? it : it.skip;

describe('docker workspace provider integration', () => {
  integrationIt('creates a reachable workspace with the default secure Docker network policy', async () => {
    const dockerInfo = spawnSync('docker', ['info'], { stdio: 'ignore', windowsHide: true });
    expect(dockerInfo.status).toBe(0);

    const sourceDirectory = await mkdtemp(join(tmpdir(), 'openchamber-docker-workspace-source-'));
    const policy = readPolicy({ defaultImage: image, allowedImages: [image], requirePinnedImage: false, egress: { httpProxy, noProxy: '127.0.0.1,localhost' } });
    expect(policy.docker.networkMode).toBe(SECURE_DOCKER_NETWORK);
    const provider = createDockerProvider({ policy, sourceDirectory });
    const info = provider.configure({ id: `integration:${Date.now()}`, projectID: 'integration' });

    try {
      await writeFile(join(sourceDirectory, 'README.md'), 'integration workspace\n');
      await provider.create(info, { OPENCODE_AUTH_CONTENT: '{}' });
      const target = await provider.target(info);
      const response = await fetch(new URL('/global/health', target.url), { headers: target.headers });

      expect(response.ok).toBe(true);
      const promptCommand = process.env.OPENCHAMBER_DOCKER_WORKSPACE_INTEGRATION_PROMPT_COMMAND;
      if (promptCommand) {
        const result = spawnSync('docker', ['exec', info.extra.runtime.container, 'sh', '-lc', promptCommand], { encoding: 'utf8', windowsHide: true });
        expect(result.status, result.stderr || result.stdout).toBe(0);
      }
    } finally {
      await provider.remove(info).catch(() => undefined);
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  }, 300_000);
});
