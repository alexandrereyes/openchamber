import type { VcsDiffError, VcsFileDiff } from '@opencode-ai/sdk/v2';
import type { VcsInfo } from '@opencode-ai/sdk/v2/client';

type BranchDiffResult = {
  data?: VcsFileDiff[];
  error?: VcsDiffError;
  response?: { status?: number };
};

export type BranchDiffRequest = {
  mode: 'branch';
  context: number;
};

type BranchDiffEntry = {
  path: string;
  index: string;
  working_dir: string;
  insertions: number;
  deletions: number;
  isNew: boolean;
  patch: string | null;
  readOnly: boolean;
};

const statusToGitCode = (status?: VcsFileDiff['status']): string => {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  return 'M';
};

const hasRenderablePatch = (patch: string | undefined): patch is string => {
  if (!patch?.trim()) return false;
  return /^diff --git /m.test(patch)
    || /^@@ /m.test(patch)
    || /^Binary files .+ differ$/m.test(patch)
    || /^GIT binary patch$/m.test(patch);
};

export const isBranchDiffAvailable = (vcs: VcsInfo | undefined): boolean => {
  const branch = vcs?.branch?.trim();
  const defaultBranch = vcs?.default_branch?.trim();
  return Boolean(branch && defaultBranch && branch !== defaultBranch);
};

export const shouldPrefetchBranchDiff = (
  diffs: readonly VcsFileDiff[] | null,
  error: string | null,
  enabled = true,
): boolean => enabled && diffs === null && error === null;

export const getBranchDiffStateKey = (
  runtimeKey: string,
  directory: string | null | undefined,
  branch: string | null | undefined,
  defaultBranch: string | null | undefined,
): string => `${runtimeKey}\0${directory ?? ''}\0${branch ?? ''}\0${defaultBranch ?? ''}`;

export const loadBranchDiff = async (
  request: (
    input: BranchDiffRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<BranchDiffResult>,
  signal?: AbortSignal,
): Promise<VcsFileDiff[]> => {
  const result = await request({ mode: 'branch', context: 3 }, { signal });
  if (result.error) {
    const status = result.response?.status;
    throw new Error(`Branch diff failed${status ? ` (${status})` : ''}: ${result.error.data.message}`);
  }
  if (!Array.isArray(result.data)) {
    throw new Error('Branch diff failed: empty response');
  }
  return result.data;
};

export const mapBranchDiffEntries = (diffs: VcsFileDiff[]): BranchDiffEntry[] =>
  diffs
    .filter((diff) => Boolean(diff.file?.trim()))
    .map((diff) => ({
      path: diff.file,
      index: '',
      working_dir: statusToGitCode(diff.status),
      insertions: diff.additions,
      deletions: diff.deletions,
      isNew: diff.status === 'added',
      patch: hasRenderablePatch(diff.patch) ? diff.patch : null,
      readOnly: true,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
