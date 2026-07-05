import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

type SmallModelResult = {
  text: string;
  providerID: string;
  modelID: string;
  source: string;
};

type SmallModelTestDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// Temporary developer dialog for exercising POST /api/small-model/generate
// end-to-end while the feature has no product consumers yet.
export const SmallModelTestDialog: React.FC<SmallModelTestDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const [prompt, setPrompt] = React.useState('');
  const [isRunning, setIsRunning] = React.useState(false);
  const [result, setResult] = React.useState<SmallModelResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleRun = React.useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isRunning) return;
    setIsRunning(true);
    setError(null);
    setResult(null);
    try {
      const response = await runtimeFetch('/api/small-model/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed }),
      });
      const payload = await response.json().catch(() => null) as (SmallModelResult & { error?: string }) | null;
      if (!response.ok || !payload || typeof payload.text !== 'string') {
        setError(payload?.error || `HTTP ${response.status}`);
        return;
      }
      setResult(payload);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setIsRunning(false);
    }
  }, [prompt, isRunning]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('dialog.smallModelTest.title')}</DialogTitle>
          <DialogDescription>{t('dialog.smallModelTest.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('dialog.smallModelTest.promptPlaceholder')}
            rows={4}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleRun();
              }
            }}
          />

          {error ? (
            <div
              className="rounded-md border px-3 py-2 typography-ui-label break-words"
              style={{
                color: currentTheme.colors.status.error,
                backgroundColor: currentTheme.colors.status.errorBackground,
                borderColor: currentTheme.colors.status.errorBorder,
              }}
            >
              {error}
            </div>
          ) : null}

          {result ? (
            <div
              className="flex flex-col gap-2 rounded-md px-3 py-2"
              style={{ backgroundColor: currentTheme.colors.surface.elevated }}
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 typography-micro" style={{ color: currentTheme.colors.surface.mutedForeground }}>
                <span>{t('dialog.smallModelTest.providerLabel')}: <span style={{ color: currentTheme.colors.surface.foreground }}>{result.providerID}</span></span>
                <span>{t('dialog.smallModelTest.modelLabel')}: <span style={{ color: currentTheme.colors.surface.foreground }}>{result.modelID}</span></span>
                <span>{result.source}</span>
              </div>
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap typography-ui-label" style={{ color: currentTheme.colors.surface.foreground }}>
                {result.text}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button onClick={() => void handleRun()} disabled={!prompt.trim() || isRunning}>
            {isRunning ? (
              <>
                <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                {t('dialog.smallModelTest.running')}
              </>
            ) : (
              t('dialog.smallModelTest.run')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
