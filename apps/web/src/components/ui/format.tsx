import type { Ratio as RatioDto } from '@shopfloor/contracts/mes-api';
import { quantityText } from '../../domain/numbers.ts';
import { NOT_APPLICABLE, percentText, ratioText } from '../../domain/oee.ts';
import {
  durationText,
  formatPlantTime,
  formatPlantTimeMinutes,
  formatPlantTimeRelative,
  isoDuration,
  wallTimeText,
} from '../../domain/time.ts';

/**
 * The formatting components (UX-1c, #315; design system 4.13 and section 6): each renders the
 * text people read by the content rules and keeps the raw value for tests and tools in
 * `data-value`, `data-fraction`, `data-decimal` or `<time dateTime>` (#295). The text functions
 * live in `domain/time.ts`, `domain/numbers.ts` and `domain/oee.ts`; no screen calls
 * `toLocaleString`.
 */

/** The reason a formatter gives when it is handed no finite number and no reason. */
export const NO_VALUE = 'No value';

interface TestIdProps {
  readonly testId?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * No value (design system 6.3): an em dash in `ink-secondary`, the reason in its tooltip and as
 * visually hidden text, so a screen reader hears why ("not applicable: no planned busy time").
 * Never "n/a", "none" or an en dash in the visible text (G-16).
 */
export function Missing({
  reason,
  reasonShown = false,
  testId,
  className,
}: {
  readonly reason: string;
  /**
   * The reason is already visible next to the dash (a `Stat`'s hint line): no visually hidden
   * copy, so a screen reader hears it once.
   */
  readonly reasonShown?: boolean;
} & TestIdProps) {
  return (
    <span
      data-testid={testId}
      data-missing=""
      title={reason}
      className={`text-ink-secondary${className ? ` ${className}` : ''}`}
    >
      <span aria-hidden="true">—</span>
      {reasonShown ? null : <span className="sr-only">{reason}</span>}
    </span>
  );
}

/**
 * A duration (design system 6.1): `45 s`, `12 min`, `4 h 54 min`, `2 d 12 h`; `seconds` adds the
 * seconds under an hour (`12 min 05 s`) where it ticks live. `<time dateTime>` holds the ISO 8601
 * duration, `data-value` the milliseconds.
 */
export function Duration({
  ms,
  seconds = false,
  missing = NO_VALUE,
  testId,
  className,
}: {
  readonly ms: number;
  readonly seconds?: boolean;
  /** Why there is no value, for a non-finite `ms` (`Missing`'s reason). */
  readonly missing?: string;
} & TestIdProps) {
  if (!Number.isFinite(ms))
    return <Missing reason={missing} testId={testId} className={className} />;
  return (
    <time
      dateTime={isoDuration(ms)}
      data-testid={testId}
      data-value={String(ms)}
      className={`tabular-nums${className ? ` ${className}` : ''}`}
    >
      {durationText(ms, { seconds })}
    </time>
  );
}

function instant(at: string | number): string {
  return typeof at === 'number' ? new Date(at).toISOString() : at;
}

/**
 * A plant time (design system 6.2): `Mon 12 Oct, 07:15:00`, or the time alone when it falls on
 * the plant clock's current day (pass `clock`); `seconds={false}` for planning times (due,
 * planned start: `Mon 12 Oct, 22:00`). The full plant date-time is in the tooltip, the instant in
 * `dateTime`.
 */
export function PlantTime({
  at,
  clock,
  seconds = true,
  testId,
  className,
}: {
  readonly at: string | number;
  /** The plant clock's instant: a time on its day shows without the date. */
  readonly clock?: string | number | undefined;
  readonly seconds?: boolean;
} & TestIdProps) {
  const text = !seconds
    ? formatPlantTimeMinutes(at)
    : clock === undefined
      ? formatPlantTime(at)
      : formatPlantTimeRelative(at, clock);
  return (
    <time
      dateTime={instant(at)}
      title={formatPlantTime(at)}
      data-testid={testId}
      className={`tabular-nums${className ? ` ${className}` : ''}`}
    >
      {text}
    </time>
  );
}

/**
 * A wall-clock time (when the MES or a person did something), always labelled so it is never read
 * as plant time (design system 6.2, Y-01): `Thu 22 Oct, 09:12:03 (wall time)`.
 */
export function WallTime({ at, testId, className }: { readonly at: string } & TestIdProps) {
  return (
    <time
      dateTime={at}
      data-testid={testId}
      className={`tabular-nums${className ? ` ${className}` : ''}`}
    >
      {wallTimeText(at)}
    </time>
  );
}

interface RatioProps extends TestIdProps {
  readonly ratio: RatioDto | null | undefined;
  /** Why the value would be null (`NA_REASON` in `oee-ui.tsx`): `Missing`'s reason. */
  readonly na: string;
  /** The reason is shown visibly beside a null value: `Missing`'s `reasonShown`. */
  readonly naShown?: boolean | undefined;
}

/**
 * The raw markers every ratio element carries: the exact fraction, the four-decimal string (both
 * `n/a` when not applicable, as the API's), and the exact fraction as the tooltip.
 */
function ratioData(ratio: RatioDto | null | undefined) {
  return {
    'data-fraction': ratio?.fraction ?? NOT_APPLICABLE,
    'data-decimal': ratioText(ratio),
  };
}

/**
 * A ratio as a percentage with two decimals (design system 6.1): `83.04 %`, with a space before
 * the sign; the four decimals in `data-decimal`, the exact fraction in `data-fraction` and the
 * tooltip. Not applicable: `Missing` with the reason.
 */
export function Percent({ ratio, na, naShown = false, testId, className }: RatioProps) {
  if (!ratio) {
    return (
      <span data-testid={testId} {...ratioData(ratio)} className={className}>
        <Missing reason={na} reasonShown={naShown} />
      </span>
    );
  }
  return (
    <span
      data-testid={testId}
      {...ratioData(ratio)}
      title={`${ratio.fraction} exactly`}
      className={`tabular-nums${className ? ` ${className}` : ''}`}
    >
      {percentText(ratio)}
    </span>
  );
}

/**
 * A ratio as the MES's four-decimal string (`0.8304`), where a figure is compared with the MES's
 * own (the reconciliation tables), with the same raw markers as `Percent`.
 */
export function Ratio({ ratio, na, testId, className }: RatioProps) {
  if (!ratio) {
    return (
      <span data-testid={testId} {...ratioData(ratio)} className={className}>
        <Missing reason={na} />
      </span>
    );
  }
  return (
    <span
      data-testid={testId}
      {...ratioData(ratio)}
      title={`${ratio.fraction} exactly`}
      className={`tabular-nums${className ? ` ${className}` : ''}`}
    >
      {ratio.decimal}
    </span>
  );
}

/**
 * A count or measured value with its unit (design system 6.1): `60 blanks`, `12,345 pieces`,
 * `3.245 Pa/min`, `−93.1 min`; `places` decimals (0 for counts), thousands grouped from 10,000
 * up, a true minus, the unit after a space. `data-value` is the raw number.
 */
export function Quantity({
  value,
  unit,
  places = 0,
  missing = NO_VALUE,
  testId,
  className,
}: {
  readonly value: number;
  readonly unit?: string;
  readonly places?: number;
  /** Why there is no value, for a non-finite `value` (`Missing`'s reason). */
  readonly missing?: string;
} & TestIdProps) {
  if (!Number.isFinite(value)) {
    return <Missing reason={missing} testId={testId} className={className} />;
  }
  return (
    <span
      data-testid={testId}
      data-value={String(value)}
      className={`tabular-nums${className ? ` ${className}` : ''}`}
    >
      {quantityText(value, places)}
      {unit === undefined ? null : ` ${unit}`}
    </span>
  );
}
