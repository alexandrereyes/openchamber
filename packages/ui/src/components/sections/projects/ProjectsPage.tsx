import React from 'react';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';
import { ProjectActionsSection } from '@/components/sections/projects/ProjectActionsSection';
import { ProjectIdentityFields } from '@/components/sections/projects/ProjectIdentityFields';
import { useProjectIdentityForm } from '@/components/sections/projects/useProjectIdentityForm';
import { useI18n } from '@/lib/i18n';

export const ProjectsPage: React.FC = () => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);

  const selectedProject = React.useMemo(() => {
    if (!selectedId) return null;
    return projects.find((p) => p.id === selectedId) ?? null;
  }, [projects, selectedId]);

  React.useEffect(() => {
    if (projects.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && projects.some((p) => p.id === selectedId)) {
      return;
    }
    setSelectedId(projects[0].id);
  }, [projects, selectedId, setSelectedId]);

  const form = useProjectIdentityForm(selectedProject);

  const selectedProjectRef = React.useMemo(() => {
    if (!selectedProject) {
      return null;
    }
    return { id: selectedProject.id, path: selectedProject.path };
  }, [selectedProject]);

  const handleSave = React.useCallback(async () => {
    if (!selectedProject) return;
    const data = await form.prepareSaveData();
    if (!data) return;
    updateProjectMeta(selectedProject.id, data);
  }, [form, selectedProject, updateProjectMeta]);

  if (!selectedProject) {
    return (
      <ScrollableOverlay outerClassName="h-full" className="w-full">
        <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
          <p className="typography-meta text-muted-foreground">{t('settings.projects.page.empty.noProjects')}</p>
        </div>
      </ScrollableOverlay>
    );
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full bg-background">
      <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedProject.label ?? t('settings.projects.page.title.default')}
            </h2>
            <p className="typography-meta text-muted-foreground truncate" title={selectedProject.path}>
              {selectedProject.path}
            </p>
          </div>
        </div>

        <div className="mb-8">
          <ProjectIdentityFields form={form} />
          <div className="mt-0.5 px-2 py-1">
            <Button
              onClick={() => void handleSave()}
              disabled={!form.hasChanges || !form.name.trim() || form.isUploadingIcon || form.isRemovingCustomIcon}
              size="xs"
              className="!font-normal"
            >
              {t('settings.common.actions.saveChanges')}
            </Button>
          </div>
        </div>

        <div data-settings-item="projects.worktree" className="mb-8">
          <section className="px-2 pb-2 pt-0">
            {selectedProjectRef && <ProjectActionsSection projectRef={selectedProjectRef} />}
          </section>
        </div>

        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.projects.page.section.worktree')}
            </h3>
          </div>
          <section className="px-2 pb-2 pt-0">
            {selectedProjectRef && <WorktreeSectionContent projectRef={selectedProjectRef} />}
          </section>
        </div>
      </div>
    </ScrollableOverlay>
  );
};
