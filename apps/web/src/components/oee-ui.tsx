import type { Ratio } from '@shopfloor/contracts/mes-api';
import { NOT_APPLICABLE, percentText, ratioText, type StatusFlag } from '../domain/oee.ts';

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
            className={`rounded border px-1.5 text-xs font-medium ${
              flag.tone === 'final'
                ? 'border-emerald-800 text-emerald-900'
                : 'border-amber-700 text-amber-950'
            }`}
          >
            {flag.text}
          </li>
        ))}
      </ul>
      <details className="text-xs text-slate-700" data-testid="flag-explanations">
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
 * reconciliation's Playwright check.
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
      title={ratio ? `${ratio.fraction} exactly` : na}
      className={className}
    >
      {ratioText(ratio)}
    </span>
  );
}

/** A headline ratio: the percentage large, the four decimals beside it. */
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
      <span className="text-3xl font-bold tabular-nums" data-testid={`${testId}-percent`}>
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
