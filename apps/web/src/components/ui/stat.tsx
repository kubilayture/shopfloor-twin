import type { ReactNode } from 'react';
import { Badge, type DataAttributes } from './badge.tsx';
import { Card } from './card.tsx';
import type { Tone } from './tokens.ts';

/**
 * A figure with its label (UX-1c, #315; design system 4.4): the label above (`text-xs` 500,
 * `ink-secondary`), the value in tabular figures sized by `emphasis`, the unit after it, a hint
 * below (the raw fraction, a comparison, "of 18"). `tone` colours the value only when it is
 * abnormal; `verdict` adds a badge (Acceptable, Overloaded). With no value (`missing`), an em dash
 * at the same size and the one-line reason under it, never "n/a" at headline size (E-01).
 */

export type StatEmphasis = 'headline' | 'default' | 'compact';

const VALUE_SIZE: Readonly<Record<StatEmphasis, string>> = {
  headline: 'text-3xl font-semibold',
  default: 'text-2xl font-semibold',
  compact: 'text-lg font-semibold',
};

/** The value's colour when abnormal: the tone's ink (AA on the white card). */
export const STAT_VALUE_TONE: Readonly<Record<Tone, string>> = {
  neutral: 'text-ink',
  info: 'text-info-ink',
  ok: 'text-ok-ink',
  warn: 'text-warn-ink',
  caution: 'text-caution-ink',
  alarm: 'text-alarm-ink',
};

export interface StatProps {
  readonly label: string;
  readonly value?: ReactNode;
  readonly unit?: string;
  readonly emphasis?: StatEmphasis;
  readonly hint?: ReactNode;
  readonly tone?: Tone | undefined;
  readonly verdict?: { readonly tone: Tone; readonly text: string } | undefined;
  /** Why there is no value ("No planned time this shift"): shown instead of the value. */
  readonly missing?: string | undefined;
  readonly testId?: string | undefined;
  /** Keeps a screen's test id on the figure itself (e.g. `${id}-percent`). */
  readonly valueTestId?: string | undefined;
  /** The raw value for tests (#295). */
  readonly dataValue?: string | undefined;
  /** `data-*` on the value's `dd` (the figure and its verdict), the markers a test reads (#295). */
  readonly detailData?: DataAttributes | undefined;
}

export function Stat({
  label,
  value,
  unit,
  emphasis = 'default',
  hint,
  tone,
  verdict,
  missing,
  testId,
  valueTestId,
  dataValue,
  detailData,
}: StatProps) {
  const absent = missing !== undefined;
  return (
    <dl data-testid={testId} className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs font-medium text-ink-secondary">{label}</dt>
      <dd {...detailData} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          data-testid={valueTestId}
          data-value={dataValue}
          className={`tabular-nums ${VALUE_SIZE[emphasis]} ${
            absent ? 'text-ink-secondary' : STAT_VALUE_TONE[tone ?? 'neutral']
          }`}
        >
          {absent ? (
            <span aria-hidden="true">—</span>
          ) : (
            <>
              {value}
              {unit === undefined ? null : (
                <span className="text-sm font-normal text-ink-secondary"> {unit}</span>
              )}
            </>
          )}
        </span>
        {verdict && !absent ? (
          <Badge tone={verdict.tone} size="md">
            {verdict.text}
          </Badge>
        ) : null}
      </dd>
      {absent ? (
        <dd className="text-xs text-ink-secondary">{missing}</dd>
      ) : hint === undefined ? null : (
        <dd className="text-xs text-ink-secondary">{hint}</dd>
      )}
    </dl>
  );
}

/**
 * A KPI card (design system 4.4): one headline `Stat` and up to four compact ones under it (two
 * per row; three in one row, as A, P and Q, UX-3); each
 * `Stat` is its own description list, so its label names its figure. `children` go under the
 * figures (the status flags, a note on how the figure is computed); `data-*` props pass through to
 * the card (its raw values for tests, #295).
 */
export function KpiTile({
  title,
  headline,
  details = [],
  status,
  tone,
  testId,
  children,
  ...data
}: {
  readonly title: ReactNode;
  readonly headline: Omit<StatProps, 'emphasis'>;
  readonly details?: readonly Omit<StatProps, 'emphasis'>[];
  /** A badge beside the title: the finality. */
  readonly status?: ReactNode;
  readonly tone?: Tone | undefined;
  readonly testId?: string | undefined;
  readonly children?: ReactNode;
} & DataAttributes) {
  return (
    <Card
      {...data}
      title={title}
      headingLevel={3}
      status={status}
      tone={tone}
      testId={testId}
      padding="compact"
    >
      <div className="flex flex-col gap-3">
        <Stat {...headline} emphasis="headline" />
        {details.length > 0 ? (
          <div
            className={`grid gap-x-4 gap-y-2 ${details.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}
          >
            {details.slice(0, 4).map((detail) => (
              <Stat key={detail.label} {...detail} emphasis="compact" />
            ))}
          </div>
        ) : null}
        {children}
      </div>
    </Card>
  );
}
