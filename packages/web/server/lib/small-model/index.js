import { readAuthFile } from '../opencode/auth.js';
import { readConfigLayers } from '../opencode/shared.js';
import { getModelCatalog } from './catalog.js';
import { resolveSmallModel, parseModelRef } from './resolve.js';
import { callSmallModel } from './call.js';

const readConfiguredSmallModel = (workingDirectory) => {
  try {
    const { mergedConfig } = readConfigLayers(workingDirectory);
    const value = mergedConfig?.small_model;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

/**
 * Generates text with the user's small model, resolved and authenticated
 * entirely server-side from the OpenCode config and auth store.
 */
export async function generateSmallModelText({ prompt, system, maxOutputTokens, model, directory }) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
  }

  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));

  const explicit = parseModelRef(model);
  const resolved = explicit
    ? { ...explicit, source: 'request' }
    : resolveSmallModel({
      auth,
      catalog,
      configSmallModel: readConfiguredSmallModel(directory),
    });

  if (!resolved) {
    throw Object.assign(
      new Error('No small model available — no authenticated provider has a suitable model'),
      { statusCode: 404 },
    );
  }

  const text = await callSmallModel({
    auth,
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    prompt: prompt.trim(),
    system: typeof system === 'string' && system.trim() ? system.trim() : undefined,
    maxOutputTokens,
  });

  return {
    text: text.trim(),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
  };
}

/**
 * Reports which model would be used, without calling it.
 */
export async function describeSmallModel({ directory } = {}) {
  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));
  const resolved = resolveSmallModel({
    auth,
    catalog,
    configSmallModel: readConfiguredSmallModel(directory),
  });
  return resolved;
}
