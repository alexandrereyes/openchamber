import type {
  WorkspacePatchApplyResult,
  WorkspaceConfigureResult,
  WorkspaceExportDiffResult,
  WorkspacePatchSummaryResult,
  WorkspaceProviderValidationInput,
  WorkspaceProviderValidationResult,
  WorkspaceSecurityAPI,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

async function readJson<T>(response: Response, fallback: T): Promise<T> {
  return response.json().catch(() => fallback) as Promise<T>;
}

export const createWebWorkspaceSecurityAPI = (): WorkspaceSecurityAPI => ({
  async validateProvider(input: WorkspaceProviderValidationInput): Promise<WorkspaceProviderValidationResult> {
    const response = await runtimeFetch('/api/workspaces/providers/validate', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      query: {
        provider: input.provider,
        ...(input.context ? { context: input.context } : {}),
        ...(input.namespace ? { namespace: input.namespace } : {}),
      },
    });
    const payload = await readJson<WorkspaceProviderValidationResult>(response, { available: false });
    if (!response.ok) return { ...payload, available: false, error: payload.error || response.statusText };
    return payload;
  },

  async configureFromSettings(): Promise<WorkspaceConfigureResult> {
    const response = await runtimeFetch('/api/workspaces/configure', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const payload = await readJson<WorkspaceConfigureResult | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw new Error('error' in payload && payload.error ? payload.error : 'Failed to configure secure workspaces');
    return payload as WorkspaceConfigureResult;
  },

  async exportDiff(input: { id: string; directory?: string | null }): Promise<WorkspaceExportDiffResult> {
    const response = await runtimeFetch(`/api/workspaces/${encodeURIComponent(input.id)}/export-diff`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      query: input.directory ? { directory: input.directory } : {},
    });
    const payload = await readJson<WorkspaceExportDiffResult | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw new Error('error' in payload && payload.error ? payload.error : 'Failed to export workspace diff');
    return payload as WorkspaceExportDiffResult;
  },

  async summarizePatch(patch: string): Promise<WorkspacePatchSummaryResult> {
    const response = await runtimeFetch('/api/workspaces/export/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ patch }),
    });
    const payload = await readJson<WorkspacePatchSummaryResult | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw new Error('error' in payload && payload.error ? payload.error : 'Failed to summarize workspace patch');
    return payload as WorkspacePatchSummaryResult;
  },

  async applyPatch(input: { directory: string; patch: string; checkOnly?: boolean }): Promise<WorkspacePatchApplyResult> {
    const response = await runtimeFetch('/api/workspaces/export/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await readJson<WorkspacePatchApplyResult>(response, {
      applied: false,
      checkOnly: input.checkOnly !== false,
      error: response.statusText,
    });
    if (!response.ok) return { ...payload, applied: false, error: payload.error || response.statusText };
    return payload;
  },
});
