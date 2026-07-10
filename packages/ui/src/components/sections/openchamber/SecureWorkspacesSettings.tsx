import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import type { WorkspacePatchSummary, WorkspaceProviderKind, WorkspaceProviderValidationResult } from '@/lib/api/types';

type SecureWorkspaceSettingsPayload = {
  secureWorkspacesEnabled?: boolean;
  secureWorkspacesDefaultProvider?: WorkspaceProviderKind;
  secureWorkspacesImage?: string;
  secureWorkspacesKubernetesContext?: string;
  secureWorkspacesKubernetesNamespace?: string;
  secureWorkspacesRequirePinnedImage?: boolean;
};

type WorkspaceListItem = {
  id: string;
  type: string;
  name: string;
  directory?: string | null;
};

const DEFAULT_IMAGE = 'ghcr.io/openchamber/opencode-workspace:1.0.0';

export const SecureWorkspacesSettings: React.FC = () => {
  const { t } = useI18n();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState(false);
  const [validating, setValidating] = React.useState<WorkspaceProviderKind | null>(null);
  const [exportBusy, setExportBusy] = React.useState(false);
  const [applyBusy, setApplyBusy] = React.useState(false);
  const [status, setStatus] = React.useState<Partial<Record<WorkspaceProviderKind, WorkspaceProviderValidationResult>>>({});
  const [workspaceList, setWorkspaceList] = React.useState<WorkspaceListItem[]>([]);
  const [selectedWorkspaceID, setSelectedWorkspaceID] = React.useState('');
  const [targetDirectory, setTargetDirectory] = React.useState(() => opencodeClient.getDirectory() ?? '');
  const [patch, setPatch] = React.useState('');
  const [patchSummary, setPatchSummary] = React.useState<WorkspacePatchSummary | null>(null);
  const [exportError, setExportError] = React.useState('');
  const [applyMessage, setApplyMessage] = React.useState('');
  const [settings, setSettings] = React.useState<Required<SecureWorkspaceSettingsPayload>>({
    secureWorkspacesEnabled: false,
    secureWorkspacesDefaultProvider: 'docker',
    secureWorkspacesImage: DEFAULT_IMAGE,
    secureWorkspacesKubernetesContext: '',
    secureWorkspacesKubernetesNamespace: 'openchamber-workspaces',
    secureWorkspacesRequirePinnedImage: true,
  });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
        const result = await runtimeSettings?.load();
        const loaded = (result?.settings ?? {}) as SecureWorkspaceSettingsPayload;
        if (cancelled) return;
        setSettings((current) => ({
          ...current,
          secureWorkspacesEnabled: loaded.secureWorkspacesEnabled === true,
          secureWorkspacesDefaultProvider: loaded.secureWorkspacesDefaultProvider === 'kubernetes' ? 'kubernetes' : 'docker',
          secureWorkspacesImage: typeof loaded.secureWorkspacesImage === 'string' && loaded.secureWorkspacesImage.trim()
            ? loaded.secureWorkspacesImage.trim()
            : DEFAULT_IMAGE,
          secureWorkspacesKubernetesContext: typeof loaded.secureWorkspacesKubernetesContext === 'string'
            ? loaded.secureWorkspacesKubernetesContext
            : '',
          secureWorkspacesKubernetesNamespace: typeof loaded.secureWorkspacesKubernetesNamespace === 'string' && loaded.secureWorkspacesKubernetesNamespace.trim()
            ? loaded.secureWorkspacesKubernetesNamespace.trim()
            : 'openchamber-workspaces',
          secureWorkspacesRequirePinnedImage: loaded.secureWorkspacesRequirePinnedImage !== false,
        }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(changes: Partial<SecureWorkspaceSettingsPayload>) {
    const previous = settings;
    setSettings((current) => ({ ...current, ...changes }));
    setSaveError(false);
    setSaving(true);
    try {
      await getRegisteredRuntimeAPIs()?.settings.save(changes);
      await getRegisteredRuntimeAPIs()?.workspaces?.configureFromSettings();
    } catch {
      setSettings(previous);
      await getRegisteredRuntimeAPIs()?.settings.save(previous).catch(() => undefined);
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  async function validate(provider: WorkspaceProviderKind) {
    const workspaces = getRegisteredRuntimeAPIs()?.workspaces;
    if (!workspaces) {
      setStatus((current) => ({ ...current, [provider]: { available: false, error: t('settings.workspaces.status.unsupported') } }));
      return;
    }
    setValidating(provider);
    try {
      const result = await workspaces.validateProvider({
        provider,
        context: provider === 'kubernetes' ? settings.secureWorkspacesKubernetesContext : undefined,
        namespace: provider === 'kubernetes' ? settings.secureWorkspacesKubernetesNamespace : undefined,
      });
      setStatus((current) => ({ ...current, [provider]: result }));
    } finally {
      setValidating(null);
    }
  }

  async function loadWorkspaces() {
    setExportBusy(true);
    setExportError('');
    try {
      const list = await opencodeClient.experimentalWorkspaces.list(targetDirectory || undefined);
      setWorkspaceList(list.map((item) => ({ id: item.id, type: item.type, name: item.name, directory: item.directory })));
      setSelectedWorkspaceID((current) => current || list[0]?.id || '');
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
    } finally {
      setExportBusy(false);
    }
  }

  async function exportSelectedWorkspace() {
    if (!selectedWorkspaceID) return;
    const workspaces = getRegisteredRuntimeAPIs()?.workspaces;
    if (!workspaces) return;
    setExportBusy(true);
    setExportError('');
    setApplyMessage('');
    try {
      const exported = await workspaces.exportDiff({ id: selectedWorkspaceID, directory: targetDirectory || undefined });
      setPatch(exported.patch);
      const summary = await workspaces.summarizePatch(exported.patch);
      setPatchSummary(summary.summary);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t('settings.workspaces.export.failed'));
    } finally {
      setExportBusy(false);
    }
  }

  async function checkPatch() {
    const workspaces = getRegisteredRuntimeAPIs()?.workspaces;
    if (!workspaces || !patch || !targetDirectory) return;
    setApplyBusy(true);
    setApplyMessage('');
    try {
      const result = await workspaces.applyPatch({ directory: targetDirectory, patch, checkOnly: true });
      setApplyMessage(result.error || t('settings.workspaces.export.checkPassed'));
    } finally {
      setApplyBusy(false);
    }
  }

  async function applyPatch() {
    const workspaces = getRegisteredRuntimeAPIs()?.workspaces;
    if (!workspaces || !patch || !targetDirectory) return;
    if (!window.confirm(t('settings.workspaces.export.confirmApply'))) return;
    setApplyBusy(true);
    setApplyMessage('');
    try {
      const result = await workspaces.applyPatch({ directory: targetDirectory, patch, checkOnly: false });
      setApplyMessage(result.error || t('settings.workspaces.export.applied'));
    } finally {
      setApplyBusy(false);
    }
  }

  if (loading) return null;

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.workspaces.title')}</h3>
        <p className="typography-meta text-muted-foreground">{t('settings.workspaces.description')}</p>
      </div>

      <section className="space-y-3 px-2 pb-2 pt-1">
        <div data-settings-item="workspaces.enable" className="flex items-center gap-2 py-1.5">
          <Checkbox
            checked={settings.secureWorkspacesEnabled}
            onChange={(checked) => void save({ secureWorkspacesEnabled: checked })}
            ariaLabel={t('settings.workspaces.enable')}
          />
          <div className="min-w-0">
            <div className="typography-ui-label text-foreground">{t('settings.workspaces.enable')}</div>
            <div className="typography-meta text-muted-foreground">{t('settings.workspaces.enableHint')}</div>
          </div>
        </div>

        <div data-settings-item="workspaces.image" className="space-y-1 py-1.5">
          <label className="typography-ui-label text-foreground" htmlFor="secure-workspaces-image">{t('settings.workspaces.image')}</label>
          <Input
            id="secure-workspaces-image"
            className="h-8"
            value={settings.secureWorkspacesImage}
            onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesImage: event.target.value }))}
            onBlur={() => void save({ secureWorkspacesImage: settings.secureWorkspacesImage.trim() || DEFAULT_IMAGE })}
          />
          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              checked={settings.secureWorkspacesRequirePinnedImage}
              onChange={(checked) => void save({ secureWorkspacesRequirePinnedImage: checked })}
              ariaLabel={t('settings.workspaces.requirePinnedImage')}
            />
            <span className="typography-meta text-muted-foreground">{t('settings.workspaces.requirePinnedImage')}</span>
          </div>
        </div>

        <div data-settings-item="workspaces.providers" className="grid gap-3 md:grid-cols-2">
          <ProviderCard
            provider="docker"
            title={t('settings.workspaces.provider.docker')}
            description={t('settings.workspaces.provider.dockerHint')}
            selected={settings.secureWorkspacesDefaultProvider === 'docker'}
            status={status.docker}
            validating={validating === 'docker'}
            onSelect={() => void save({ secureWorkspacesDefaultProvider: 'docker' })}
            onValidate={() => void validate('docker')}
            validateLabel={t('settings.workspaces.actions.validate')}
            selectedLabel={t('settings.workspaces.default')}
          />
          <ProviderCard
            provider="kubernetes"
            title={t('settings.workspaces.provider.kubernetes')}
            description={t('settings.workspaces.provider.kubernetesHint')}
            selected={settings.secureWorkspacesDefaultProvider === 'kubernetes'}
            status={status.kubernetes}
            validating={validating === 'kubernetes'}
            onSelect={() => void save({ secureWorkspacesDefaultProvider: 'kubernetes' })}
            onValidate={() => void validate('kubernetes')}
            validateLabel={t('settings.workspaces.actions.validate')}
            selectedLabel={t('settings.workspaces.default')}
          />
        </div>

        <div data-settings-item="workspaces.kubernetes" className="grid gap-2 py-1.5 md:grid-cols-2">
          <label className="space-y-1">
            <span className="typography-ui-label text-foreground">{t('settings.workspaces.kubernetes.context')}</span>
            <Input className="h-8" value={settings.secureWorkspacesKubernetesContext} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesContext: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesContext: settings.secureWorkspacesKubernetesContext.trim() })} />
          </label>
          <label className="space-y-1">
            <span className="typography-ui-label text-foreground">{t('settings.workspaces.kubernetes.namespace')}</span>
            <Input className="h-8" value={settings.secureWorkspacesKubernetesNamespace} onChange={(event) => setSettings((current) => ({ ...current, secureWorkspacesKubernetesNamespace: event.target.value }))} onBlur={() => void save({ secureWorkspacesKubernetesNamespace: settings.secureWorkspacesKubernetesNamespace.trim() || 'openchamber-workspaces' })} />
          </label>
        </div>

        <div data-settings-item="workspaces.export" className="space-y-2 py-1.5">
          <div>
            <div className="typography-ui-label text-foreground">{t('settings.workspaces.export.title')}</div>
            <div className="typography-meta text-muted-foreground">{t('settings.workspaces.export.description')}</div>
          </div>
          <label className="space-y-1">
            <span className="typography-meta text-muted-foreground">{t('settings.workspaces.export.directory')}</span>
            <Input className="h-8" value={targetDirectory} onChange={(event) => setTargetDirectory(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={() => void loadWorkspaces()} disabled={exportBusy}>{t('settings.workspaces.export.load')}</Button>
            <Button size="xs" variant="default" onClick={() => void exportSelectedWorkspace()} disabled={exportBusy || !selectedWorkspaceID}>{t('settings.workspaces.export.review')}</Button>
          </div>
          {workspaceList.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {workspaceList.map((workspace) => (
                <Button key={workspace.id} size="xs" variant="chip" aria-pressed={workspace.id === selectedWorkspaceID} onClick={() => setSelectedWorkspaceID(workspace.id)}>
                  {workspace.name || workspace.id}
                </Button>
              ))}
            </div>
          )}
          {patchSummary && (
            <div className="typography-meta text-muted-foreground">
              {t('settings.workspaces.export.summary', {
                files: String(patchSummary.totalFiles),
                additions: String(patchSummary.additions),
                deletions: String(patchSummary.deletions),
              })}
            </div>
          )}
          {patch && (
            <>
              <Textarea value={patch} readOnly className="min-h-40 font-mono typography-code text-xs" aria-label={t('settings.workspaces.export.patch')} />
              <div className="flex flex-wrap gap-2">
                <Button size="xs" variant="outline" onClick={() => void checkPatch()} disabled={applyBusy || !targetDirectory}>{t('settings.workspaces.export.check')}</Button>
                <Button size="xs" variant="default" onClick={() => void applyPatch()} disabled={applyBusy || !targetDirectory}>{t('settings.workspaces.export.apply')}</Button>
              </div>
            </>
          )}
          {exportError && <div className="typography-meta text-[var(--status-error)]">{exportError}</div>}
          {applyMessage && <div className="typography-meta text-muted-foreground">{applyMessage}</div>}
        </div>

        {saving && <div className="typography-meta text-muted-foreground">{t('settings.workspaces.saving')}</div>}
        {saveError && <div className="typography-meta text-[var(--status-error)]">{t('settings.workspaces.saveFailed')}</div>}
      </section>
    </div>
  );
};

function ProviderCard(props: {
  provider: WorkspaceProviderKind;
  title: string;
  description: string;
  selected: boolean;
  status?: WorkspaceProviderValidationResult;
  validating: boolean;
  onSelect: () => void;
  onValidate: () => void;
  validateLabel: string;
  selectedLabel: string;
}) {
  const { t } = useI18n();
  const statusText = props.status
    ? props.status.available
      ? t('settings.workspaces.status.available')
      : props.status.error || t('settings.workspaces.status.unavailable')
    : t('settings.workspaces.status.notChecked');
  return (
    <div className="rounded-lg border border-border bg-[var(--surface-elevated)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="typography-ui-label text-foreground">{props.title}</div>
          <div className="typography-meta text-muted-foreground">{props.description}</div>
        </div>
        {props.selected && <span className="typography-micro rounded-full bg-[var(--interactive-selection)] px-2 py-0.5 text-[var(--interactive-selection-foreground)]">{props.selectedLabel}</span>}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className={props.status?.available ? 'typography-meta text-[var(--status-success)]' : 'typography-meta text-muted-foreground'}>{statusText}</span>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={props.onSelect}>{t('settings.workspaces.actions.use')}</Button>
          <Button size="xs" variant="outline" onClick={props.onValidate} disabled={props.validating}>{props.validating ? t('settings.workspaces.actions.validating') : props.validateLabel}</Button>
        </div>
      </div>
    </div>
  );
}
