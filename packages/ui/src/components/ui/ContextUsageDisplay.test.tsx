import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { ContextUsageDisplay } from './ContextUsageDisplay';

describe('ContextUsageDisplay accessibility', () => {
  test('makes static desktop details focusable and names the progress value', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContextUsageDisplay
          totalTokens={32_200}
          percentage={3.1}
          contextLimit={1_000_000}
          outputLimit={32_000}
          hideIcon
          showPercentIcon
        />
      </I18nProvider>,
    );

    expect(markup).toContain('<button');
    expect(markup).toContain('type="button"');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Context usage"');
    expect(markup).toContain('aria-valuetext="32.2K (3.1%)"');
  });
});
