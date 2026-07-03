import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProjectIdentityFields } from '@/components/sections/projects/ProjectIdentityFields';
import { useProjectIdentityForm } from '@/components/sections/projects/useProjectIdentityForm';
import type { ProjectEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectEntry | null;
  onSave: (data: {
    label: string;
    icon: string | null;
    color: string | null;
    iconBackground: string | null;
    defaultModel: string | undefined;
  }) => void;
}

export const ProjectEditDialog: React.FC<ProjectEditDialogProps> = ({
  open,
  onOpenChange,
  project,
  onSave,
}) => {
  const { t } = useI18n();
  const form = useProjectIdentityForm(open ? project : null);

  const handleSave = React.useCallback(async () => {
    const data = await form.prepareSaveData();
    if (!data) return;
    onSave(data);
    onOpenChange(false);
  }, [form, onOpenChange, onSave]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-2 min-w-0">
          <DialogTitle>{t('projectEditDialog.title')}</DialogTitle>
        </DialogHeader>

        <ScrollableOverlay outerClassName="max-h-[min(70vh,32rem)]" className="w-full">
          <div className="px-4 pb-2">
            <ProjectIdentityFields form={form} />
          </div>
        </ScrollableOverlay>

        <DialogFooter className="px-6 py-4 border-t border-border/40">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('projectEditDialog.actions.cancel')}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!form.name.trim() || form.isUploadingIcon || form.isRemovingCustomIcon}
          >
            {t('projectEditDialog.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
