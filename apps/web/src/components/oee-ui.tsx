import type { Ratio } from '@shopfloor/contracts/mes-api';
import { NOT_APPLICABLE, percentText, ratioText, type StatusFlag } from '../domain/oee.ts';
import { TONE_CLASS, badgeShape } from './ui/badge.tsx';
import { Icon } from './ui/icons.tsx';

/**
 * A status flag's look (design system 2.6): final is a neutral outline with a check, provisional a
 * neutral dashed outline, a revision `info`; what else may change (incidents, may be revised,
 * above 1) is `warn`.
 */
function flagClass(flag: StatusFlag): string {
  if (flag.key === 'final') return TONE_CLASS.neutral.outline;
  if (flag.key === 'provisional') return TONE_CLASS.neutral.dashed;
  if (flag.key === 'revision') return TONE_CLASS.info.outline;
  return TONE_CLASS.warn.outline;
}

/**
 * Status flags of an order or line OEE value (#233) as a list of text badges: final or
 * provisional, revision, incidents, may be revised, above 1. Never colour alone; each carries its
 * key in `data-flag`. What each means is in a disclosure beside them, open to the keyboard and to
 * touch (#233 review), and in each badge's tooltip.
 */
export function StatusFlags({
  flags,
  label = 'Status',
}: {
  readonly flags: readonly StatusFlag[];
  readonly label?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-wrap gap-1" aria-label={label}>
        {flags.map((flag) => (
          <li
            key={flag.key}
            title={flag.title}
            data-flag={flag.key}
            className={`${badgeShape()} ${flagClass(flag)}`}
          >
            {flag.key === 'final' ? <Icon name="check" size={12} /> : null}
            {flag.text}
          </li>
        ))}
      </ul>
      <details className="text-xs text-ink-secondary" data-testid="flag-explanations">
        <summary className="cursor-pointer">What the status means</summary>
        <dl className="mt-1">
          {flags.map((flag) => (
            <div key={flag.key}>
              <dt className="inline font-medium">{flag.text}: </dt>
              <dd className="inline">{flag.title}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

/** Why a ratio of `oee-core` is null (`oeeResultSchema`), for its tooltip. */
export const NA_REASON = {
  availability: 'Not applicable: no planned busy time',
  performance: 'Not applicable: no planned busy time or no production time',
  quality: 'Not applicable: no planned busy time or nothing produced',
  oee: 'Not applicable: no planned busy time, or cycles counted without production time',
  yield: 'Not applicable: no blank taken yet',
  line: 'Not applicable: no planned line time',
} as const;

/**
 * A ratio as the MES sends it: the four-decimal string as text (`n/a` when null), the exact
 * fraction in `data-fraction` and the tooltip, or why it is not applicable. Read by the
 * reconciliation's Playwright check. `data-decimal` holds the four-decimal string too (UX-1c,
 * #315), so the specs can move to it before the visible text becomes a percentage.
 */
export function RatioValue({
  ratio,
  na,
  testId,
  className = 'font-mono tabular-nums',
}: {
  readonly ratio: Ratio | null | undefined;
  /** Why the value would be null (`NA_REASON`). */
  readonly na: string;
  readonly testId?: string;
  readonly className?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-fraction={ratio?.fraction ?? NOT_APPLICABLE}
      data-decimal={ratioText(ratio)}
      title={ratio ? `${ratio.fraction} exactly` : na}
      className={className}
    >
      {ratioText(ratio)}
    </span>
  );
}

/** A headline ratio: the percentage large (its `data-decimal` raw), the four decimals beside it. */
export function RatioHeadline({
  label,
  ratio,
  na,
  testId,
}: {
  readonly label: string;
  readonly ratio: Ratio | null | undefined;
  readonly na: string;
  readonly testId: string;
}) {
  return (
    <p>
      <span className="text-sm text-slate-700">{label} </span>
      <span
        className="text-3xl font-bold tabular-nums"
        data-testid={`${testId}-percent`}
        data-decimal={ratioText(ratio)}
      >
        {percentText(ratio)}
      </span>{' '}
      <RatioValue
        ratio={ratio}
        na={na}
        testId={testId}
        className="ml-1 font-mono text-sm text-slate-700"
      />
    </p>
  );
}
