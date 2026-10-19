import type { Ratio } from '@shopfloor/contracts/mes-api';
import { NOT_APPLICABLE, percentText, ratioText, type StatusFlag } from '../domain/oee.ts';

/**
 * Status flags of an order or line OEE value (#233) as a list of text badges: final or
 * provisional, revision, incidents, may be revised, above 1. Never colour alone; each carries
 * its explanation as a tooltip and its key in `data-flag`.
 */
export function StatusFlags({
  flags,
  label = 'Status',
}: {
  readonly flags: readonly StatusFlag[];
  readonly label?: string;
}) {
  return (
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
  );
}

/**
 * A ratio as the MES sends it: the four-decimal string as text (`n/a` when null), the exact
 * fraction in `data-fraction` and the tooltip. Read by the reconciliation's Playwright check.
 */
export function RatioValue({
  ratio,
  testId,
  className = 'font-mono tabular-nums',
}: {
  readonly ratio: Ratio | null | undefined;
  readonly testId?: string;
  readonly className?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-fraction={ratio?.fraction ?? NOT_APPLICABLE}
      title={ratio ? `${ratio.fraction} exactly` : 'Not applicable: nothing planned'}
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
  testId,
}: {
  readonly label: string;
  readonly ratio: Ratio | null | undefined;
  readonly testId: string;
}) {
  return (
    <p>
      <span className="text-sm text-slate-700">{label} </span>
      <span className="text-3xl font-bold tabular-nums" data-testid={`${testId}-percent`}>
        {percentText(ratio)}
      </span>{' '}
      <RatioValue ratio={ratio} testId={testId} className="ml-1 font-mono text-sm text-slate-700" />
    </p>
  );
}
