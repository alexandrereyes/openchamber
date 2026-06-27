import React from 'react';

import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Captures notification-tap deep-links for the native iOS app and opens the target
 * session — even when the tap happens before we're connected (cold launch, or while
 * the connect screen is showing).
 *
 * The tap listener is registered UNCONDITIONALLY (unlike token registration, which is
 * gated on `isConnected`): a cold-launch `pushNotificationActionPerformed` fires before
 * the app has connected, so a connected-only listener would miss it and the deep-link
 * would be lost on the login screen. We stash the tapped `sessionId` in a module-level
 * holder that survives the connect flow + SyncProvider remount, then navigate as soon
 * as the app is `ready` (connected + initialized). If a tap arrives while already ready,
 * we navigate immediately.
 */

let pendingSessionId: string | null = null;

const isCapacitorNative = (): boolean => {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as typeof window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
};

export const useNativePushDeepLink = (options: { ready: boolean }): void => {
  const { ready } = options;
  const readyRef = React.useRef(ready);
  readyRef.current = ready;

  // Navigate now if the app is ready; otherwise stash until it is.
  const applyOrStash = React.useCallback((sessionId: string) => {
    if (readyRef.current) {
      void useSessionUIStore.getState().setCurrentSession(sessionId);
    } else {
      pendingSessionId = sessionId;
    }
  }, []);

  React.useEffect(() => {
    if (!isCapacitorNative()) return;
    let disposed = false;
    let remove: (() => void) | null = null;

    void import('@capacitor/push-notifications')
      .then(async ({ PushNotifications }) => {
        if (disposed) return;
        const handle = await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const data = action?.notification?.data as Record<string, unknown> | undefined;
          const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : undefined;
          if (sessionId) applyOrStash(sessionId);
        });
        if (disposed) {
          void handle.remove();
          return;
        }
        remove = () => void handle.remove();
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      remove?.();
    };
  }, [applyOrStash]);

  // Drain a stashed deep-link once the app becomes ready (connected + initialized).
  React.useEffect(() => {
    if (!ready || !pendingSessionId) return;
    const sessionId = pendingSessionId;
    pendingSessionId = null;
    void useSessionUIStore.getState().setCurrentSession(sessionId);
  }, [ready]);
};
