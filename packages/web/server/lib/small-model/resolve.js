import { getCatalogProvider } from './catalog.js';

// Mirrors OpenCode's getSmallModel fallback chain:
// 1. `small_model` from the merged config layers ("provider/model").
// 2. GitHub Copilot's hidden utility models when Copilot is logged in.
// 3. Family-priority scan of the authenticated providers' catalog models.
const FAMILY_PRIORITY = ['gemini-flash', 'gpt-nano', 'claude-haiku'];
const COPILOT_UTILITY_MODELS = ['gpt-5.4-nano', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'];
// The ChatGPT-plan codex backend only accepts a small allowlist of models
// (nano/API-key models are rejected with 400) — this is its cheapest one.
const OPENAI_OAUTH_SMALL_MODEL = 'gpt-5.4-mini';

const AUTH_PROVIDER_ALIASES = {
  'github-copilot': ['github-copilot', 'copilot'],
};

export function getAuthEntryForProvider(auth, providerID) {
  const aliases = AUTH_PROVIDER_ALIASES[providerID] || [providerID];
  for (const alias of aliases) {
    const entry = auth?.[alias];
    if (entry && typeof entry === 'object') {
      return entry;
    }
  }
  return null;
}

export function isUsableAuthEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'api') return typeof entry.key === 'string' && entry.key.length > 0;
  if (entry.type === 'oauth') {
    return (typeof entry.access === 'string' && entry.access.length > 0)
      || (typeof entry.refresh === 'string' && entry.refresh.length > 0);
  }
  if (entry.type === 'wellknown') return typeof entry.token === 'string' && entry.token.length > 0;
  return false;
}

export function parseModelRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

const pickByFamily = (models, family) => {
  const matches = Object.values(models)
    .filter((model) => model && typeof model === 'object' && model.family === family);
  if (matches.length === 0) return null;
  matches.sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));
  return matches[0];
};

export function resolveSmallModel({ auth, catalog, configSmallModel }) {
  const explicit = parseModelRef(configSmallModel);
  if (explicit) {
    return { ...explicit, source: 'config' };
  }

  const authedProviders = Object.keys(auth || {}).filter((providerID) =>
    isUsableAuthEntry(auth[providerID]));

  for (const family of FAMILY_PRIORITY) {
    for (const providerID of authedProviders) {
      if (providerID === 'openai' && auth.openai?.type === 'oauth') {
        if (family === 'gpt-nano') {
          return { providerID, modelID: OPENAI_OAUTH_SMALL_MODEL, source: 'codex-small' };
        }
        continue;
      }
      const provider = getCatalogProvider(catalog, providerID);
      if (!provider || !provider.models || typeof provider.models !== 'object') continue;
      const model = pickByFamily(provider.models, family);
      if (model?.id) {
        return { providerID, modelID: model.id, source: 'family-scan' };
      }
    }
  }

  // Copilot's small models are hidden utility models that never appear in the
  // catalog, so the family scan above can't find them.
  const copilotEntry = getAuthEntryForProvider(auth, 'github-copilot');
  if (isUsableAuthEntry(copilotEntry)) {
    return {
      providerID: 'github-copilot',
      modelID: COPILOT_UTILITY_MODELS[0],
      source: 'copilot-utility',
    };
  }

  return null;
}
