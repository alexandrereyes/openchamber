import type {
  WorkspacePatchApplyResult,
  WorkspaceCompatibilityResult,
  WorkspaceConfigureResult,
  WorkspaceExportDiffResult,
  WorkspacePatchSummaryResult,
  WorkspaceProviderValidationResult,
  WorkspaceSecurityAPI,
} from '@openchamber/ui/lib/api/types';

const unsupported = 'Workspace runtime provider management is not available in the VS Code webview yet.';

export const createVSCodeWorkspaceSecurityAPI = (): WorkspaceSecurityAPI => ({
  async validateProvider(): Promise<WorkspaceProviderValidationResult> {
    return { available: false, error: unsupported };
  },
  async compatibility(): Promise<WorkspaceCompatibilityResult> {
    return { configured: false, active: false, supported: false, adapterKinds: [], status: 'not-configured', error: unsupported };
  },
  async configureFromSettings(): Promise<WorkspaceConfigureResult> {
    return { configured: false, enabled: false };
  },
  async exportDiff(): Promise<WorkspaceExportDiffResult> {
    throw new Error(unsupported);
  },
  async summarizePatch(): Promise<WorkspacePatchSummaryResult> {
    throw new Error(unsupported);
  },
  async applyPatch(input: { checkOnly?: boolean }): Promise<WorkspacePatchApplyResult> {
    return { applied: false, checkOnly: input.checkOnly !== false, error: unsupported };
  },
});
