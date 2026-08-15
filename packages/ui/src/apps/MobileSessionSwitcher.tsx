import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { Icon } from '@/components/icon/Icon';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { toast } from '@/components/ui';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { useSwitcherItems } from '@/components/session/sidebar/hooks/useSwitcherItems';
import { useTabletLayout } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { refreshGlobalSessions, resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatus } from '@/sync/sync-context';

import { archiveMobileSessionSubtree, deleteMobileSessionSubtree } from './mobileSessionArchive';

const RECENT_SESSIONS_LIMIT = 10;
/** Matches the metadata popover's width so both header dropdowns read as a pair. */
const TABLET_POPOVER_WIDTH = 380;
const SWITCHER_ROW_ACTIONS_WIDTH = 96;
const SWITCHER_ROW_SWIPE_SNAP_MS = 180;

const getSessionTitle = (session: Session, fallback: string): string =>
  session.title?.trim() || fallback;

/** One switcher row: live status (busy spinner / attention dot), title,
    "project · branch", compact time. Mirrors the desktop SessionSwitcherDropdown
    indicator conventions; no subsession chevrons on mobile by design. */
const SwitcherRow: React.FC<{
  session: Session;
  meta: string;
  active: boolean;
  onSelect: () => void;
  revealed: boolean;
  onRevealedChange: (revealed: boolean) => void;
  confirmingDelete: boolean;
  onArchive: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
}> = ({
  session,
  meta,
  active,
  onSelect,
  revealed,
  onRevealedChange,
  confirmingDelete,
  onArchive,
  onRequestDelete,
  onConfirmDelete,
}) => {
  const { t } = useI18n();
  const status = useGlobalSessionStatus(session.id);
  const unseenCount = useSessionUnseenCount(session.id);
  const statusType = status?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const showUnreadDot = !isStreaming && unseenCount > 0 && !active;
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const showActivityDuration = (isStreaming || showUnreadDot) && hasActivityDuration;
  const timeLabel = formatSessionCompactDateLabel(session.time?.updated ?? session.time?.created ?? 0);
  const title = getSessionTitle(session, t('sessions.sidebar.session.untitled'));

  const contentRef = React.useRef<HTMLButtonElement>(null);
  const startRef = React.useRef<{ x: number; y: number } | null>(null);
  const draggingRef = React.useRef(false);
  const offsetRef = React.useRef(0);
  const revealedRef = React.useRef(revealed);
  const suppressClickRef = React.useRef(false);

  // Keep the drag on the compositor path. React state changes only when the
  // gesture snaps open or closed, never for individual touchmove frames.
  const applyOffset = React.useCallback((px: number, animate: boolean) => {
    const element = contentRef.current;
    if (!element) return;
    element.style.transition = animate ? `transform ${SWITCHER_ROW_SWIPE_SNAP_MS}ms ease-out` : 'none';
    element.style.transform = px === 0 ? 'none' : `translateX(${px}px)`;
    offsetRef.current = px;
  }, []);

  React.useEffect(() => {
    revealedRef.current = revealed;
    applyOffset(revealed ? -SWITCHER_ROW_ACTIONS_WIDTH : 0, true);
  }, [applyOffset, revealed]);

  const handleTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length !== 1) return;
    suppressClickRef.current = false;
    const touch = event.touches[0];
    startRef.current = { x: touch.clientX, y: touch.clientY };
    draggingRef.current = false;
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    if (!startRef.current) return;
    const touch = event.touches[0];
    const dx = touch.clientX - startRef.current.x;
    const dy = touch.clientY - startRef.current.y;
    if (!draggingRef.current) {
      // Let the browser own vertical scrolling; claim the gesture only after
      // clear horizontal intent.
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      draggingRef.current = true;
    }
    const base = revealedRef.current ? -SWITCHER_ROW_ACTIONS_WIDTH : 0;
    applyOffset(Math.min(0, Math.max(-SWITCHER_ROW_ACTIONS_WIDTH, base + dx)), false);
  };

  const handleTouchEnd = () => {
    startRef.current = null;
    if (!draggingRef.current) return;
    draggingRef.current = false;
    // A touch gesture can still produce one compat click. Consume it so a
    // snap-open or snap-closed swipe does not immediately toggle/select.
    suppressClickRef.current = true;
    const shouldReveal = offsetRef.current < -SWITCHER_ROW_ACTIONS_WIDTH / 2;
    applyOffset(shouldReveal ? -SWITCHER_ROW_ACTIONS_WIDTH : 0, true);
    if (shouldReveal !== revealedRef.current) {
      // Prevent the synthetic click after a swipe from selecting the session.
      revealedRef.current = shouldReveal;
      onRevealedChange(shouldReveal);
    }
  };

  return (
    <div
      className="relative overflow-hidden rounded-xl"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      style={{ touchAction: 'pan-y' }}
    >
      <div
        className="absolute inset-y-0 right-0 flex items-stretch bg-[var(--surface-elevated)]"
        style={{ width: SWITCHER_ROW_ACTIONS_WIDTH }}
        aria-hidden={!revealed}
      >
        <button
          type="button"
          tabIndex={revealed ? 0 : -1}
          className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          aria-label={t('mobile.sessions.archiveSessionAria', { title })}
          onClick={onArchive}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="archive" className="size-[18px]" />
        </button>
        <button
          type="button"
          tabIndex={revealed ? 0 : -1}
          className={cn(
            'flex flex-1 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive',
            confirmingDelete
              ? 'rounded-lg bg-destructive text-destructive-foreground'
              : 'text-[var(--status-error)] active:opacity-80',
          )}
          aria-label={confirmingDelete
            ? t('mobile.sessions.confirmDeleteSessionAria', { title })
            : t('mobile.sessions.deleteSessionAria', { title })}
          onClick={confirmingDelete ? onConfirmDelete : onRequestDelete}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="delete-bin" className="size-[18px]" />
        </button>
      </div>
      <button
        ref={contentRef}
        type="button"
        className={cn(
          'relative flex w-full items-center gap-3 rounded-xl bg-[var(--surface-elevated)] px-2.5 py-2 text-left transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
          active && 'bg-[color-mix(in_srgb,var(--primary)_10%,var(--surface-elevated))]',
        )}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          // A tap on an open row closes its actions instead of selecting it.
          if (revealedRef.current) {
            onRevealedChange(false);
            return;
          }
          onSelect();
        }}
        style={{ touchAction: 'manipulation' }}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn('block truncate typography-ui-label', active ? 'text-primary' : 'text-foreground')}>
            {title}
          </span>
          {meta ? (
            <span className="block truncate typography-micro text-muted-foreground">{meta}</span>
          ) : null}
        </span>
        {/* Activity sits on the right, before the time — no reserved left gutter. */}
        {isStreaming || showUnreadDot ? (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              isStreaming ? 'bg-primary' : 'bg-[var(--status-info)]',
            )}
            aria-hidden
          />
        ) : null}
        {/* The elapsed turn takes the time slot while it matters, then hands it
            back to the relative timestamp. */}
        {showActivityDuration ? (
          <SessionActivityDuration
            sessionId={session.id}
            running={isStreaming}
            className="typography-micro"
          />
        ) : timeLabel ? (
          <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{timeLabel}</span>
        ) : null}
      </button>
    </div>
  );
};

/** Recent-sessions popover under the mobile header, opened by tapping the
    session title. Same visual family as the metadata/usage overlay. */
export const MobileSessionSwitcher: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}> = ({ open, onClose, anchorRef }) => {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = React.useState(open);
  const [isExiting, setIsExiting] = React.useState(false);
  // Tablet: a phone-width sheet stretched across the whole chat column looks
  // broken — anchor a popover under the title instead. Mirror image of the
  // metadata/usage popover, which anchors to the ring on the right.
  const { enabled: isTabletLayout } = useTabletLayout();
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [anchorLeft, setAnchorLeft] = React.useState<number | null>(null);

  // The shell has transformed ancestors, so the fixed wrapper's containing
  // block is the chat column, NOT the viewport — anchor in the wrapper's own
  // coordinate space (see SessionMetadataOverlay for the same reasoning).
  React.useLayoutEffect(() => {
    if (!open || !isTabletLayout || !shouldRender) return;
    const compute = () => {
      const anchorRect = anchorRef.current?.getBoundingClientRect();
      const wrapperRect = wrapperRef.current?.getBoundingClientRect();
      if (!anchorRect || !wrapperRect) {
        setAnchorLeft(null);
        return;
      }
      const relativeLeft = anchorRect.left - wrapperRect.left;
      setAnchorLeft(Math.min(
        Math.max(relativeLeft, 8),
        Math.max(8, wrapperRect.width - TABLET_POPOVER_WIDTH - 8),
      ));
    };
    compute();
    // Re-anchor if the chat column shifts while the popover is open (sidebar
    // toggle/resize, orientation change) — the header buttons move with it.
    const wrapper = wrapperRef.current;
    if (typeof ResizeObserver === 'undefined' || !wrapper) return;
    const observer = new ResizeObserver(compute);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [anchorRef, isTabletLayout, open, shouldRender]);

  const isPopover = isTabletLayout && anchorLeft !== null;
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const [revealedSessionId, setRevealedSessionId] = React.useState<string | null>(null);
  const [confirmingDeleteSessionId, setConfirmingDeleteSessionId] = React.useState<string | null>(null);

  const items = useSwitcherItems(open || shouldRender, { maxParents: RECENT_SESSIONS_LIMIT });

  React.useEffect(() => {
    if (open) {
      // Fresh authoritative snapshot on open — updated stamps re-sort recents
      // (see raiseSessionOrderingBaselines) while the cached list shows first.
      void refreshGlobalSessions();
      setShouldRender(true);
      setIsExiting(false);
      return;
    }
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
    if (!shouldRender) return;
    setIsExiting(true);
    const timeoutId = window.setTimeout(() => {
      setShouldRender(false);
      setIsExiting(false);
    }, 140);
    return () => window.clearTimeout(timeoutId);
  }, [open, shouldRender]);

  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  React.useEffect(() => {
    if (!open) return;
    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        onClose();
        return;
      }
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', closeIfOutside, true);
    return () => document.removeEventListener('pointerdown', closeIfOutside, true);
  }, [anchorRef, onClose, open]);

  const handleSelect = React.useCallback((session: Session) => {
    void setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
    onClose();
  }, [onClose, setCurrentSession]);

  const handleRowRevealedChange = (sessionId: string, nextRevealed: boolean) => {
    setRevealedSessionId(nextRevealed ? sessionId : null);
    setConfirmingDeleteSessionId(null);
  };

  const captureMobileSessionDirectory = (sessionId: string, candidate?: Session): string | null => (
    (candidate ? resolveGlobalSessionDirectory(candidate) : null)
    ?? useSessionUIStore.getState().getDirectoryForSession(sessionId)
    ?? normalizePath(useDirectoryStore.getState().currentDirectory)
    ?? null
  );

  const handleArchive = async (session: Session) => {
    const { activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
    const { archivedIds, failedIds, targetCount } = await archiveMobileSessionSubtree({
      sessions: [...activeSessions, ...archivedSessions],
      rootId: session.id,
      expectedRuntimeKey: getRuntimeKey(),
      archiveSessions,
      captureDirectory: captureMobileSessionDirectory,
    });

    if (targetCount === 1) {
      if (failedIds.length === 0) toast.success(t('sessions.sidebar.session.archive.success'));
      else toast.error(t('sessions.sidebar.session.archive.error'));
      return;
    }

    if (archivedIds.length > 0) {
      toast.success(archivedIds.length === 1
        ? t('sessions.sidebar.bulkActions.archivedSingle', { count: archivedIds.length })
        : t('sessions.sidebar.bulkActions.archivedPlural', { count: archivedIds.length }));
    }
    if (failedIds.length > 0) {
      toast.error(failedIds.length === 1
        ? t('sessions.sidebar.bulkActions.failedArchiveSingle', { count: failedIds.length })
        : t('sessions.sidebar.bulkActions.failedArchivePlural', { count: failedIds.length }));
    }
  };

  const handleConfirmDelete = async (session: Session) => {
    const { activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
    const { deletedIds, failedIds, targetCount } = await deleteMobileSessionSubtree({
      sessions: [...activeSessions, ...archivedSessions],
      rootId: session.id,
      expectedRuntimeKey: getRuntimeKey(),
      deleteSessions,
      captureDirectory: captureMobileSessionDirectory,
    });

    if (targetCount === 1) {
      if (failedIds.length === 0) toast.success(t('sessions.sidebar.session.delete.success'));
      else toast.error(t('sessions.sidebar.session.delete.error'));
      return;
    }

    if (deletedIds.length > 0) {
      toast.success(deletedIds.length === 1
        ? t('sessions.sidebar.bulkActions.deletedSingle', { count: deletedIds.length })
        : t('sessions.sidebar.bulkActions.deletedPlural', { count: deletedIds.length }));
    }
    if (failedIds.length > 0) {
      toast.error(failedIds.length === 1
        ? t('sessions.sidebar.bulkActions.failedDeleteSingle', { count: failedIds.length })
        : t('sessions.sidebar.bulkActions.failedDeletePlural', { count: failedIds.length }));
    }
  };

  if (!shouldRender) return null;

  return (
    <div ref={wrapperRef} className="fixed inset-x-0 bottom-0 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-header-height,56px))] z-20 pointer-events-none">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('sessions.switcher.openAria')}
        className={cn(
          'flex flex-col overflow-hidden rounded-[20px] border border-border/70 bg-[var(--surface-elevated)] p-2 shadow-[0_12px_32px_rgb(0_0_0_/_0.2)] will-change-transform',
          isPopover ? 'absolute origin-top-left' : 'mx-3 mt-2',
          isExiting ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        style={{
          animation: `${isExiting ? 'session-switcher-out' : 'session-switcher-in'} ${isExiting ? 140 : 170}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`,
          maxHeight: 'min(72dvh, calc(100dvh - var(--oc-safe-area-top, 0px) - var(--oc-header-height, 56px) - 1rem))',
          ...(isPopover
            ? {
                top: 8,
                left: anchorLeft ?? 8,
                width: `min(${TABLET_POPOVER_WIDTH}px, calc(100% - 16px))`,
              }
            : null),
        }}
      >
        <div className="oc-hide-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center typography-small text-muted-foreground">
              {t('sessions.switcher.empty')}
            </p>
          ) : (
            items.map((item) => {
              const session = item.node.session;
              const meta = [item.secondaryMeta?.projectLabel, item.secondaryMeta?.branchLabel]
                .filter(Boolean)
                .join(' · ');
              return (
                <SwitcherRow
                  key={session.id}
                  session={session}
                  meta={meta}
                  active={session.id === currentSessionId}
                  revealed={revealedSessionId === session.id}
                  onRevealedChange={(nextRevealed) => handleRowRevealedChange(session.id, nextRevealed)}
                  confirmingDelete={confirmingDeleteSessionId === session.id}
                  onArchive={() => void handleArchive(session)}
                  onRequestDelete={() => setConfirmingDeleteSessionId(session.id)}
                  onConfirmDelete={() => void handleConfirmDelete(session)}
                  onSelect={() => {
                    if (item.projectId) setActiveProjectIdOnly(item.projectId);
                    handleSelect(session);
                  }}
                />
              );
            })
          )}
        </div>
      </div>
      <style>{`
        @keyframes session-switcher-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes session-switcher-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(-6px) scale(0.985); }
        }
      `}</style>
    </div>
  );
};
