import type { Ratio } from '@shopfloor/contracts/mes-api';
import type { BucketFlag, StatusFlag } from '../domain/oee.ts';
import { minutesText } from '../domain/oee.ts';
import { FinalityBadge } from './finality-badge.tsx';
import { Badge, TONE_CLASS, badgeShape } from './ui/badge.tsx';
import { Percent } from './ui/format.tsx';
import { Icon } from './ui/icons.tsx';
import type { StatProps } from './ui/stat.tsx';

/** A flag as a badge: the key, the word and what it means (its tooltip). */
type Flag = Pick<StatusFlag, 'key' | 'text' | 'title'>;

/**
 * A status flag's look (design system 2.6): final is a neutral outline with a check, provisional a
 * neutral dashed outline, a revision `info`; what else may change (incidents, may be revised,
 * above 1, an anomaly) is `warn`.
 */
function flagClass(flag: Flag): string {
  if (flag.key === 'final') return TONE_CLASS.neutral.outline;
  if (flag.key === 'provisional') return TONE_CLASS.neutral.dashed;
  if (flag.key === 'revision') return TONE_CLASS.info.outline;
  return TONE_CLASS.warn.outline;
}

/** The flags as a list of text badges, each with its key in `data-flag` and its meaning as tooltip. */
export function FlagBadges({
  flags,
  label = 'Status',
}: {
  readonly flags: readonly Flag[];
  readonly label?: string;
}) {
  return (
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
  );
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
      <FlagBadges flags={flags} label={label} />
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
 * A ratio as a `Stat`'s figure (UX-6b, UX-3): the percentage, its four decimals in
 * `data-decimal` and the exact fraction in `data-fraction` and the tooltip; when it does not
 * apply, the dash with its reason as the visible hint line under it, said once (E-01).
 */
export function ratioStat(
  label: string,
  ratio: Ratio | null | undefined,
  na: string,
  testId?: string,
): Omit<StatProps, 'emphasis'> {
  return {
    label,
    value: <Percent ratio={ratio} na={na} naShown={!ratio} testId={testId} />,
    hint: ratio ? undefined : na,
  };
}

/** Whether a group of buckets is all final, all provisional or a mix (none: no bucket). */
export type GroupFinality = 'final' | 'provisional' | 'mixed';

export function groupFinality(
  buckets: readonly { readonly final: boolean }[],
): GroupFinality | undefined {
  if (buckets.length === 0) return undefined;
  const final = buckets.filter((bucket) => bucket.final).length;
  return final === buckets.length ? 'final' : final === 0 ? 'provisional' : 'mixed';
}

/**
 * The finality of a section's buckets, said once beside its heading (E-03): Final, Provisional
 * (the most time that may still change in its tooltip), or how many are final. `data-finality`
 * carries `final`, `provisional` or `mixed`.
 */
export function SectionFinality({
  buckets,
  testId,
}: {
  readonly buckets: readonly { readonly final: boolean; readonly provisionalMs: number }[];
  readonly testId: string;
}) {
  const finality = groupFinality(buckets);
  if (finality === undefined) return null;
  const open = Math.max(0, ...buckets.map((bucket) => bucket.provisionalMs));
  const title =
    finality === 'final'
      ? 'Nothing that can still arrive changes these values'
      : `Time in pieces that may still change: up to ${minutesText(open)} per item`;
  if (finality !== 'mixed') {
    return <FinalityBadge final={finality === 'final'} title={title} testId={testId} />;
  }
  const final = buckets.filter((bucket) => bucket.final).length;
  return (
    <Badge
      tone="neutral"
      variant="dashed"
      data-testid={testId}
      data-finality="mixed"
      title={`${title}; the provisional ones say so`}
    >
      {final} of {buckets.length} final
    </Badge>
  );
}

/**
 * An item's own flags under a section's finality (E-03): its finality only when the section is
 * a mix, then revision, incidents and an anomaly, which are never the same for every item.
 */
export function itemFlags(flags: readonly BucketFlag[], finality: GroupFinality | undefined) {
  return flags.filter(
    (flag) => (flag.key !== 'final' && flag.key !== 'provisional') || finality === 'mixed',
  );
}
