// Reproduction tests for issue #2269:
// Session goal auditor fails to expand `{env:VAR}` placeholders in provider options
//
// Verdict from exploration: `callSmallModel()` -> `readProviderConfig()` ->
// `resolveConfigApiKey()` DOES correctly expand `{env:...}` placeholders.
// The 401 Unauthorized error described in the issue can be reproduced when the
// credential flows through auth.json (not the config) and contains a raw
// `{env:...}` string, OR when the env var is unavailable at process runtime.
// See the analysis in issue #2269 for full details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../opencode/shared.js', () => {
  const readConfigLayers = vi.fn();
  return {
    readConfig: vi.fn(),
    readConfigLayers,
    readConfigFile: vi.fn(),
  };
});

vi.mock('./catalog.js', () => ({
  getCatalogProvider: vi.fn(() => null),
  getModelCatalog: vi.fn(async () => ({})),
}));

vi.mock('../opencode/auth.js', () => ({
  readAuthFile: vi.fn(),
  writeAuthFile: vi.fn(),
}));

const { callSmallModel } = await import('./call.js');
const { readConfig, readConfigLayers } = await import('../opencode/shared.js');
const { readAuthFile } = await import('../opencode/auth.js');

const ok = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content }, finish_reason: 'stop' }],
  }),
  text: async () => JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
  }),
});

const authError = () => ({
  ok: false,
  status: 401,
  text: async () => JSON.stringify({
    error: {
      message: "API Virtual Key expected. Received={env****KEY}, expected to start with 'sk-'.",
      type: 'auth_error',
      code: '401',
    },
  }),
});

const lastCall = (mock) => {
  const [url, init] = mock.mock.calls.at(-1);
  return { url: String(url), init };
};

describe('Issue 2269: {env:...} expansion in session goal auditor path', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    readConfig.mockReset();
    readConfigLayers.mockReset();
    readAuthFile.mockReset();
    delete process.env.REPRO_CUSTOM_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.REPRO_CUSTOM_API_KEY;
  });

  // -----------------------------------------------------------------------
  // callSmallModel directly — proves the expansion logic itself works
  // -----------------------------------------------------------------------

  it('expands {env:...} when the env var is set (config-sourced credential)', async () => {
    process.env.REPRO_CUSTOM_API_KEY = 'sk-real-key-12345';
    readConfig.mockReturnValue({
      provider: {
        'my-custom': {
          options: {
            apiKey: '{env:REPRO_CUSTOM_API_KEY}',
            baseURL: 'https://api.example.com/v1',
          },
        },
      },
    });
    fetchMock.mockResolvedValue(ok('audit result'));

    const text = await callSmallModel({
      auth: {},
      catalog: {},
      workingDirectory: '/proj',
      providerID: 'my-custom',
      modelID: 'some-model',
      prompt: 'test',
    });

    expect(text).toBe('audit result');
    expect(lastCall(fetchMock).init.headers.Authorization).toBe('Bearer sk-real-key-12345');
  });

  it('throws without making an API call when the env var is NOT set (no credential)', async () => {
    // env var NOT set — resolveConfigApiKey returns null -> auth null
    readConfig.mockReturnValue({
      provider: {
        'my-custom': {
          options: {
            apiKey: '{env:REPRO_CUSTOM_API_KEY}',
            baseURL: 'https://api.example.com/v1',
          },
        },
      },
    });

    await expect(callSmallModel({
      auth: {},
      catalog: {},
      workingDirectory: '/proj',
      providerID: 'my-custom',
      modelID: 'some-model',
      prompt: 'test',
    })).rejects.toThrow('No OpenCode login found for provider "my-custom"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers expanded config key over auth.json key when both are present', async () => {
    process.env.REPRO_CUSTOM_API_KEY = 'sk-config-expanded';
    readConfig.mockReturnValue({
      provider: {
        'my-custom': {
          options: {
            apiKey: '{env:REPRO_CUSTOM_API_KEY}',
            baseURL: 'https://api.example.com/v1',
          },
        },
      },
    });
    fetchMock.mockResolvedValue(ok('ok'));

    await callSmallModel({
      auth: { 'my-custom': { type: 'api', key: 'sk-authjson-key' } },
      catalog: {},
      workingDirectory: '/proj',
      providerID: 'my-custom',
      modelID: 'some-model',
      prompt: 'test',
    });

    // Config key (expanded) wins over auth.json key
    expect(lastCall(fetchMock).init.headers.Authorization).toBe('Bearer sk-config-expanded');
  });

  // -----------------------------------------------------------------------
  // The 401 reproduction (exact error from the bug report)
  // -----------------------------------------------------------------------

  it('REPRODUCES THE BUG: auth.json with raw {env:...} string causes 401', async () => {
    // Scenario: the env var is NOT available at runtime (e.g. server daemon
    // without the user's shell env). readProviderConfig resolves {env:...}
    // to null, so the entry falls through to auth.json. If auth.json happens
    // to carry the literal placeholder, it is sent as-is → 401.
    delete process.env.REPRO_CUSTOM_API_KEY;

    readConfig.mockReturnValue({
      provider: {
        'my-custom': {
          options: {
            apiKey: '{env:REPRO_CUSTOM_API_KEY}',
            baseURL: 'https://api.example.com/v1',
          },
        },
      },
    });

    // auth.json stores the RAW placeholder string
    readAuthFile.mockReturnValue({
      'my-custom': { type: 'api', key: '{env:REPRO_CUSTOM_API_KEY}' },
    });
    fetchMock.mockResolvedValue(authError());

    try {
      await callSmallModel({
        auth: { 'my-custom': { type: 'api', key: '{env:REPRO_CUSTOM_API_KEY}' } },
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'my-custom',
        modelID: 'some-model',
        prompt: 'test',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      // Matches the bug report's exact error message pattern
      expect(error.message).toContain('my-custom request failed with 401');
      expect(error.message).toContain('{env');
    }
  });

  // -----------------------------------------------------------------------
  // Full auditor flow through generateSmallModelText
  // -----------------------------------------------------------------------

  it('FULL FLOW: generateSmallModelText expands {env:...} via config (provider in auth.json + config has {env:...})', async () => {
    const { generateSmallModelText } = await import('./index.js');

    process.env.REPRO_CUSTOM_API_KEY = 'sk-real-key-12345';

    // Provider has an auth.json entry so resolveSmallModel can find it
    readAuthFile.mockReturnValue({
      'my-custom': { type: 'api', key: 'sk-authjson-fallback' },
    });

    // Config has {env:...} which takes precedence over auth.json
    readConfig.mockReturnValue({
      provider: {
        'my-custom': {
          options: {
            apiKey: '{env:REPRO_CUSTOM_API_KEY}',
            baseURL: 'https://api.example.com/v1',
          },
        },
      },
    });

    fetchMock.mockResolvedValue(ok('audit verdict'));

    const result = await generateSmallModelText({
      prompt: 'Audit progress',
      system: 'You are an auditor',
      directory: '/proj',
      preferredProviderID: 'my-custom',
      preferredModelID: 'my-model',
      restrictToPreferredProvider: true,
    });

    expect(result.text).toBe('audit verdict');
    expect(lastCall(fetchMock).init.headers.Authorization).toBe('Bearer sk-real-key-12345');
    // Ensure the raw {env:...} string is NOT leaked
    expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain('{env:');
  });

  it('FULL FLOW: generateSmallModelText with small_model config, no auth entry needed', async () => {
    const { generateSmallModelText } = await import('./index.js');

    process.env.REPRO_CUSTOM_API_KEY = 'sk-real-key-12345';

    // No auth entry for the custom provider
    readAuthFile.mockReturnValue({});

    // small_model explicitly configured + provider options with {env:...}
    const providerCfg = {
      'my-custom': {
        options: {
          apiKey: '{env:REPRO_CUSTOM_API_KEY}',
          baseURL: 'https://api.example.com/v1',
        },
      },
    };
    readConfig.mockReturnValue({
      small_model: 'my-custom/audit-model',
      provider: providerCfg,
    });
    readConfigLayers.mockReturnValue({
      mergedConfig: {
        small_model: 'my-custom/audit-model',
        provider: providerCfg,
      },
      paths: {},
    });

    fetchMock.mockResolvedValue(ok('audit verdict'));

    const result = await generateSmallModelText({
      prompt: 'Audit progress',
      directory: '/proj',
      preferredProviderID: 'my-custom',
      preferredModelID: 'my-model',
      restrictToPreferredProvider: true,
    });

    expect(result.text).toBe('audit verdict');
    expect(lastCall(fetchMock).init.headers.Authorization).toBe('Bearer sk-real-key-12345');
  });

  it('FULL FLOW: fails gracefully (404) when provider is only in config, not in auth.json or small_model', async () => {
    const { generateSmallModelText } = await import('./index.js');

    process.env.REPRO_CUSTOM_API_KEY = 'sk-real-key-12345';

    // No auth entry for ANY provider
    readAuthFile.mockReturnValue({});

    // Config has the provider with {env:...} but no small_model setting
    readConfig.mockReturnValue({
      provider: {
        'my-custom': {
          options: {
            apiKey: '{env:REPRO_CUSTOM_API_KEY}',
            baseURL: 'https://api.example.com/v1',
          },
        },
      },
    });

    // resolveSmallModel returns null (no authenticated providers, no small_model config)
    // → 404 thrown BEFORE any API call
    await expect(generateSmallModelText({
      prompt: 'Audit',
      directory: '/proj',
      preferredProviderID: 'my-custom',
      preferredModelID: 'my-model',
      restrictToPreferredProvider: true,
    })).rejects.toThrow('No small model available');

    // No API call was made → no 401 leak
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('handles various {env:...} variable name formats', async () => {
    const cases = [
      { varName: 'API_KEY', value: 'sk-key-1' },
      { varName: 'CUSTOM_PROVIDER_API_KEY', value: 'sk-key-2' },
      { varName: 'MY_VAR', value: 'sk-key-3' },
      { varName: 'API_KEY_2024', value: 'sk-key-4' },
      { varName: 'LOWERCASE_var', value: 'sk-key-5' },
    ];

    for (const { varName, value } of cases) {
      process.env[varName] = value;
      readConfig.mockReturnValue({
        provider: {
          custom: {
            options: {
              apiKey: `{env:${varName}}`,
              baseURL: 'https://api.example.com/v1',
            },
          },
        },
      });
      fetchMock.mockResolvedValue(ok('ok'));

      await callSmallModel({
        auth: {},
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'model',
        prompt: 'hi',
      });

      expect(lastCall(fetchMock).init.headers.Authorization).toBe(`Bearer ${value}`);
      delete process.env[varName];
    }
  });
});
