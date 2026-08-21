import React from 'react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { clampPercent, resolveUsageTone } from '@/lib/quota';
import { formatContextUsageValues } from './contextUsageFormat';

interface ContextUsageDisplayProps {
  totalTokens: number;
  percentage: number;
  colorPercentage?: number;
  contextLimit: number;
  outputLimit?: number;
  cost?: number | null;
  size?: 'default' | 'compact';
  isMobile?: boolean;
  hideIcon?: boolean;
  showPercentIcon?: boolean;
  className?: string;
  valueClassName?: string;
  percentIconClassName?: string;
  onClick?: () => void;
  pressed?: boolean;
}

export const ContextUsageDisplay: React.FC<ContextUsageDisplayProps> = ({
  totalTokens,
  percentage,
  colorPercentage,
  contextLimit,
  outputLimit,
  cost = null,
  size = 'default',
  isMobile = false,
  hideIcon = false,
  showPercentIcon = false,
  className,
  valueClassName,
  percentIconClassName,
  onClick,
  pressed = false,
}) => {
  const { t } = useI18n();
  const [mobileTooltipOpen, setMobileTooltipOpen] = React.useState(false);
  const intlLocale = getCurrentIntlLocale();
  const colorPct = typeof colorPercentage === 'number' ? colorPercentage : percentage;
  const progressPct = clampPercent(percentage) ?? 0;
  const progressTone = resolveUsageTone(colorPct);
  const progressColor = progressTone === 'critical'
    ? 'var(--status-error)'
    : progressTone === 'warn'
      ? 'var(--status-warning)'
      : 'var(--status-success)';

  const formatTokens = (tokens: number) => {
    return new Intl.NumberFormat(intlLocale, {
      notation: tokens >= 1_000 ? 'compact' : 'standard',
      maximumFractionDigits: 1,
    }).format(tokens);
  };

  const { tokens: formattedTokens, percentage: formattedPercentage } = formatContextUsageValues(
    totalTokens,
    percentage,
    intlLocale,
  );
  const accessibleValue = t('contextUsage.aria.value', {
    tokens: formattedTokens,
    percentage: formattedPercentage,
  });

  const getPercentageColor = (pct: number) => {
    if (pct >= 90) return 'text-status-error';
    if (pct >= 75) return 'text-status-warning';
    return 'text-status-success';
  };

  const circularProgressSize = 20;
  const circularProgressStroke = 3;
  const circularProgressRadius = (circularProgressSize - circularProgressStroke) / 2;
  const circularProgressCircumference = 2 * Math.PI * circularProgressRadius;
  const circularProgressOffset = circularProgressCircumference * (1 - progressPct / 100);

  const safeOutputLimit = typeof outputLimit === 'number' ? Math.max(outputLimit, 0) : 0;
  const normalizedCost = cost ?? 0;
  const hasCost = normalizedCost > 0 && Number.isFinite(normalizedCost);
  const tooltipLines = [
    t('contextUsage.tooltip.usedTokens', { tokens: formatTokens(totalTokens) }),
    t('contextUsage.tooltip.contextLimit', { tokens: formatTokens(contextLimit) }),
    t('contextUsage.tooltip.outputLimit', { tokens: formatTokens(safeOutputLimit) }),
    ...(hasCost ? [t('contextUsage.tooltip.cost', { cost: formatMoney(normalizedCost) })] : []),
  ];

  const isInteractive = !isMobile && typeof onClick === 'function';

  const contextContent = (
    <>
      {!isMobile && !hideIcon && <Icon name="donut-chart" className="h-4 w-4 flex-shrink-0" />}
      <span className={cn('font-medium inline-flex items-center gap-1.5', valueClassName)}>
        {showPercentIcon ? (
          <>
            <svg
              viewBox={`0 0 ${circularProgressSize} ${circularProgressSize}`}
              className={cn('h-3.5 w-3.5 -rotate-90', percentIconClassName)}
              aria-hidden="true"
            >
              <circle
                cx={circularProgressSize / 2}
                cy={circularProgressSize / 2}
                r={circularProgressRadius}
                fill="none"
                stroke="var(--interactive-border)"
                strokeWidth={circularProgressStroke}
              />
              <circle
                cx={circularProgressSize / 2}
                cy={circularProgressSize / 2}
                r={circularProgressRadius}
                fill="none"
                stroke={progressColor}
                strokeWidth={circularProgressStroke}
                strokeLinecap="round"
                strokeDasharray={circularProgressCircumference}
                strokeDashoffset={circularProgressOffset}
                className="transition-[stroke-dashoffset,stroke] duration-300"
              />
            </svg>
            <span className="whitespace-nowrap text-foreground">
              {formattedTokens} ({formattedPercentage})
            </span>
          </>
        ) : (
          <>
            <span className={getPercentageColor(colorPct)}>{formattedPercentage}</span>
          </>
        )}
      </span>
    </>
  );

  const sharedClassName = cn(
    'app-region-no-drag flex items-center gap-1.5 select-none',
    size === 'compact' ? 'typography-micro' : 'typography-meta',
    isInteractive
      ? cn(
        'rounded-md px-2 py-1.5 text-foreground transition-colors',
        'hover:bg-interactive-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
      )
      : cn(
        'rounded-sm text-muted-foreground/60',
        !isMobile && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
      ),
    className,
  );

  const contextElement = isInteractive ? (
    <button
      type="button"
      className={sharedClassName}
      aria-label={accessibleValue}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {contextContent}
    </button>
  ) : (
    <div
      className={sharedClassName}
      role={!isMobile ? 'progressbar' : undefined}
      aria-label={!isMobile ? t('contextUsage.aria.label') : undefined}
      aria-valuenow={!isMobile ? Math.round(progressPct) : undefined}
      aria-valuemin={!isMobile ? 0 : undefined}
      aria-valuemax={!isMobile ? 100 : undefined}
      aria-valuetext={!isMobile ? accessibleValue : undefined}
      tabIndex={!isMobile ? 0 : undefined}
      onClick={isMobile ? () => setMobileTooltipOpen(true) : undefined}
    >
      {contextContent}
    </div>
  );

  if (isMobile) {
    return (
      <>
        {contextElement}
        <MobileOverlayPanel
          open={mobileTooltipOpen}
          onClose={() => setMobileTooltipOpen(false)}
          title={t('contextUsage.mobile.title')}
        >
          <div className="flex flex-col gap-1.5">
            <div className="rounded-xl border border-border/40 bg-sidebar/30 px-3 py-2 space-y-1">
              <div className="flex justify-between items-center">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.usedTokens')}</span>
                <span className="typography-meta text-foreground font-medium">{formatTokens(totalTokens)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.contextLimit')}</span>
                <span className="typography-meta text-foreground font-medium">{formatTokens(contextLimit)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.outputLimit')}</span>
                <span className="typography-meta text-foreground font-medium">{formatTokens(safeOutputLimit)}</span>
              </div>
              {hasCost ? (
                <div className="flex justify-between items-center">
                  <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.cost')}</span>
                  <span className="typography-meta text-foreground font-medium">{formatMoney(normalizedCost)}</span>
                </div>
              ) : null}
              <div className="flex justify-between items-center pt-1 border-t border-border/40">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.usage')}</span>
                <span className={cn('typography-meta font-semibold', getPercentageColor(colorPct))}>
                  {formattedPercentage}
                </span>
              </div>
            </div>
          </div>
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{contextElement}</TooltipTrigger>
      <TooltipContent>
        <div className="space-y-0.5">
          {tooltipLines.map((line) => (
            <p key={line} className="typography-micro leading-tight">
              {line}
            </p>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};
