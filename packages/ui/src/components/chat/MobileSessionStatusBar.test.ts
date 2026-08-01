import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./MobileSessionStatusBar.tsx', import.meta.url), 'utf8');

describe('MobileSessionStatusBar hidden work', () => {
  test('does not mount session grouping and project derivation while the panel is closed', () => {
    const wrapperStart = source.indexOf('export const MobileSessionStatusBar');
    const openPanelStart = source.indexOf('const MobileSessionStatusOpenPanel');
    const closedGuard = source.indexOf('if (!isMobile || !open) return null;', wrapperStart);
    const openPanelMount = source.indexOf('<MobileSessionStatusOpenPanel', wrapperStart);

    expect(openPanelStart).toBeGreaterThan(-1);
    expect(closedGuard).toBeGreaterThan(wrapperStart);
    expect(openPanelMount).toBeGreaterThan(closedGuard);
    expect(source.indexOf('useSessionGrouping(', openPanelStart)).toBeLessThan(wrapperStart);
  });

  test('keeps archive actions separate from session selection and archives the known subtree', () => {
    expect(source).toContain('confirmingArchiveSessionId');
    expect(source).toContain('disabled={confirmingArchive}');
    expect(source).toContain('disabled={archivePending}');
    expect(source).toContain('onRequestArchive={() => handleRequestArchive(session.id)}');
    expect(source).toContain('collectActiveSessionSubtreeIds');
    expect(source).toContain('beginMobileSessionArchive()');
    expect(source).toContain('endMobileSessionArchive()');
    expect(source).toContain('await globalRefreshPromiseRef.current?.catch(() => undefined)');
    expect(source).toContain('archiveSessions(ids, { expectedRuntimeKey })');
    expect(source).toContain("return t('mobile.sessions.untitled');");
  });
});
