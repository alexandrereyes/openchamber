import type {
  WorkspacePatchApplyResult,
  WorkspaceConfigureResult,
  WorkspaceExportDiffResult,
  WorkspacePatchSummaryResult,
  WorkspaceProviderValidationInput,
  WorkspaceProviderValidationResult,
  WorkspaceSecurityAPI,
} from '@openchamber/ui/lib/api/types';

const unsupported = 'Workspace runtime provider management is not available in the VS Code webview yet.';

export const createVSCodeWorkspaceSecurityAPI = (): WorkspaceSecurityAPI => ({
  async validateProvider(_input: WorkspaceProviderValidationInput): Promise<WorkspaceProviderValidationResult> {
    return { available: false, error: unsupported };
  },
  async configureFromSettings(): Promise<WorkspaceConfigureResult> {
    return { configured: false, enabled: false };
  },
  async exportDiff(_input: { id: string; directory?: string | null }): Promise<WorkspaceExportDiffResult> {
    throw new Error(unsupported);
  },
  async summarizePatch(_patch: string): Promise<WorkspacePatchSummaryResult> {
    throw new Error(unsupported);
  },
  async applyPatch(input: { checkOnly?: boolean }): Promise<WorkspacePatchApplyResult> {
    return { applied: false, checkOnly: input.checkOnly !== false, error: unsupported };
  },
});
