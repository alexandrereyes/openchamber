import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerWalkthroughRoutes } from './routes.js';

// These run over real HTTP on purpose. The bug this file exists for was
// invisible to unit tests: the service and the store were both correct, and the
// response was dropped by a disconnect check that misread a healthy request.

const SOURCE = { kind: 'working-tree', scope: 'all' };

describe('walkthrough routes', () => {
  let server;
  let base;
  let releaseJob;
  let job;
  let generationRequests;

  let lastArgs;

  const waitForJob = async () => {
    const deadline = Date.now() + 5_000;
    while (!releaseJob && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!releaseJob) throw new Error('generation job did not start');
  };

  const waitForGenerationRequests = async (count) => {
    const deadline = Date.now() + 5_000;
    while (generationRequests < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (generationRequests < count) throw new Error(`generation request ${count} did not attach`);
  };

  const service = {
    async getWalkthrough(args) {
      lastArgs = args;
      return { walkthrough: null, hunks: [], hunkCount: 0, generating: Boolean(job) };
    },
    async generateWalkthrough(args) {
      lastArgs = args;
      generationRequests += 1;
      if (job) return job;
      job = new Promise((resolve) => {
        releaseJob = () => resolve({ walkthrough: { title: 'DONE' }, hunks: [], hunkCount: 1 });
      }).finally(() => { job = null; });
      return job;
    },
    async cancelWalkthroughGeneration() {
      return { cancelled: Boolean(job) };
    },
  };

  const generate = (signal) => fetch(`${base}/api/walkthrough/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ directory: '/repo', source: SOURCE }),
    signal,
  });

  beforeEach(async () => {
    job = null;
    generationRequests = 0;
    releaseJob = undefined;
    lastArgs = undefined;
    const app = express();
    app.use(express.json());
    registerWalkthroughRoutes(app, { getWalkthroughService: async () => service });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  it('answers a generation request that nobody interrupted', async () => {
    const pending = generate();
    await waitForJob();
    releaseJob();

    const body = await (await pending).json();

    expect(body.walkthrough).toEqual({ title: 'DONE' });
  });

  it('delivers the result to a client that reconnected after a refresh', async () => {
    const target = new URL(`${base}/api/walkthrough/generate`);
    const abandoned = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
    });
    abandoned.on('error', () => {});
    abandoned.end(JSON.stringify({ directory: '/repo', source: SOURCE }));
    await waitForJob();
    abandoned.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reconnectedApp = express();
    reconnectedApp.use(express.json());
    registerWalkthroughRoutes(reconnectedApp, { getWalkthroughService: async () => service });
    const reconnectedServer = reconnectedApp.listen(0);
    await new Promise((resolve) => reconnectedServer.once('listening', resolve));
    const reconnectedBase = `http://127.0.0.1:${reconnectedServer.address().port}`;

    try {
      // The reloaded page sees work in progress and re-attaches to it.
      const read = await (await fetch(
        `${reconnectedBase}/api/walkthrough?directory=/repo&source=${encodeURIComponent(JSON.stringify(SOURCE))}`,
      )).json();
      expect(read.generating).toBe(true);

      const reattached = fetch(`${reconnectedBase}/api/walkthrough/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({ directory: '/repo', source: SOURCE }),
      });
      await waitForGenerationRequests(2);
      releaseJob();

      const body = await (await reattached).json();
      expect(body.walkthrough).toEqual({ title: 'DONE' });
    } finally {
      reconnectedServer.closeAllConnections();
      reconnectedServer.close();
    }
  });

  it('rejects a request without a directory before touching the service', async () => {
    const response = await fetch(`${base}/api/walkthrough/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: SOURCE }),
    });

    expect(response.status).toBe(400);
    expect(job).toBeNull();
  });

  // The language belongs to the request, not to a setting, so both the read
  // and the generation have to carry it: readiness is computed from a prompt
  // that contains the language instruction.
  it('carries the requested language into the service', async () => {
    await fetch(
      `${base}/api/walkthrough?directory=/repo&language=uk&source=${encodeURIComponent(JSON.stringify(SOURCE))}`,
    );
    expect(lastArgs.language).toBe('uk');

    const pending = fetch(`${base}/api/walkthrough/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/repo', source: SOURCE, language: 'ja' }),
    });
    await waitForJob();
    releaseJob();
    await pending;

    expect(lastArgs.language).toBe('ja');
  });

  it('ignores a language that is not a string', async () => {
    await fetch(
      `${base}/api/walkthrough?directory=/repo&language[]=uk&source=${encodeURIComponent(JSON.stringify(SOURCE))}`,
    );

    expect(lastArgs.language).toBeUndefined();
  });

  it('cancels through its own endpoint rather than a dropped connection', async () => {
    generate().catch(() => {});
    await waitForJob();

    const response = await fetch(`${base}/api/walkthrough/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/repo', source: SOURCE }),
    });

    expect(await response.json()).toEqual({ cancelled: true });
    releaseJob();
  });
});
