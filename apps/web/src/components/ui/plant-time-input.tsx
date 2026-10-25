import { useId, useState, type FocusEvent, type ReactNode } from 'react';
import {
  formatPlantTime,
  parseIsoInstant,
  parsePlantClock,
  parsePlantDate,
  plantClockText,
  plantDateText,
  plantDayLabel,
  plantDayOf,
  plantDaysBetween,
  plantInstant,
  PLANT_TIME_ZONE,
  utcInstantText,
} from '../../domain/time.ts';
import { SelectControl } from './controls.tsx';
import { controlClass, FieldError, FieldHint, type ControlSize } from './field.tsx';

/**
 * The one way to enter a time (UX-1d2, #319; design system 4.8; N-02, D-05, C-07): two plain
 * text boxes in plant time (Europe/Istanbul), date `dd/mm/yyyy` (a select of the days between
 * `min` and `max` when both bound it) and time `hh:mm` or `hh:mm:ss`, never the native pickers
 * (they follow the OS locale). The hint shows, live, the UTC instant as it will be sent. A whole
 * value typed or filled into the time box is taken at once (`14:05:09`); with bounds the day is the
 * one the time falls on inside them (a night shift crosses midnight). The `console` variant is
 * labelled simulation time and also takes a whole ISO 8601 instant in the time box
 * (`2026-10-12T05:00:00Z`), as the console's specs fill it. The value is ISO 8601 UTC, as the API
 * takes it, or null while the boxes are empty or do not name a time.
 */

export type PlantTimeVariant = 'plant' | 'console';

export interface PlantTimeInputProps {
  readonly label: string;
  /** Every control has a name (G-23): the boxes are `<name>-date` and `<name>-time`, and a hidden
   * input `<name>` carries the ISO value for a native form. */
  readonly name: string;
  /** ISO 8601 UTC, or null for none. */
  readonly value: string | null;
  /** The ISO 8601 UTC instant, or null while the boxes are empty or name no (allowed) time. */
  readonly onChange: (iso: string | null) => void;
  /** `hh:mm:ss` instead of `hh:mm` (the downtime split). */
  readonly withSeconds?: boolean | undefined;
  /** ISO bounds, inclusive (the shift, the record). Both: the date is a select of their days. */
  readonly min?: string | undefined;
  readonly max?: string | undefined;
  readonly required?: boolean | undefined;
  /** On the time box (the one the specs fill); the date box gets `<testId>-date`, the UTC line
   * `<testId>-utc`. */
  readonly testId?: string | undefined;
  readonly variant?: PlantTimeVariant | undefined;
  /** A line of the caller's above the UTC line. */
  readonly hint?: ReactNode | undefined;
  /** The caller's error (a required time missing); the input's own format error comes first. */
  readonly error?: string | undefined;
  /** An ISO instant whose plant day fills an empty, unbounded date box (the plant clock's day). */
  readonly defaultDate?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly size?: ControlSize | undefined;
  readonly className?: string | undefined;
}

/** What the two boxes say. */
export type PlantTimeReading =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ok'; readonly instant: number; readonly day: string }
  | { readonly kind: 'error'; readonly field: 'date' | 'time'; readonly message: string };

interface ReadOptions {
  readonly withSeconds: boolean;
  readonly variant: PlantTimeVariant;
  readonly min?: string | undefined;
  readonly max?: string | undefined;
}

function timeMessage({ withSeconds, variant }: ReadOptions): string {
  const iso =
    variant === 'console' ? ', or a whole ISO 8601 instant such as 2026-10-12T05:00:00Z' : '';
  const example = withSeconds ? 'hh:mm:ss, for example 14:05:09' : 'hh:mm, for example 14:05';
  return `Enter the time as ${example}${iso}.`;
}

const DATE_MESSAGE = 'Enter the date as dd/mm/yyyy, for example 12/10/2026.';

function rangeMessage(min: string | undefined, max: string | undefined): string {
  if (min !== undefined && max !== undefined) {
    return `Enter a time between ${formatPlantTime(min)} and ${formatPlantTime(max)}.`;
  }
  if (min !== undefined) return `Enter a time from ${formatPlantTime(min)} on.`;
  return `Enter a time up to ${formatPlantTime(max ?? '')}.`;
}

function within(instant: number, min: string | undefined, max: string | undefined): boolean {
  return (
    (min === undefined || instant >= Date.parse(min)) &&
    (max === undefined || instant <= Date.parse(max))
  );
}

/**
 * Reads the boxes in the plant zone. `date` is the typed text, or with both bounds the chosen day
 * (`2026-10-12`) or `''` for "the day the time falls on inside the bounds".
 */
export function readPlantTime(date: string, time: string, options: ReadOptions): PlantTimeReading {
  const { variant, min, max } = options;
  const bounded = min !== undefined && max !== undefined;
  const timeText = time.trim();
  const dateText = date.trim();
  const checked = (instant: number, day: string): PlantTimeReading =>
    within(instant, min, max)
      ? { kind: 'ok', instant, day }
      : { kind: 'error', field: 'time', message: rangeMessage(min, max) };

  if (variant === 'console') {
    const instant = parseIsoInstant(timeText);
    if (instant !== undefined) return checked(instant, plantDayOf(instant));
  }
  // No time is no value, whatever the date box says (a prefilled `defaultDate`, a day picked):
  // an optional field tabbed through stays quiet; a required one is the caller's `error`.
  if (timeText === '') return { kind: 'empty' };
  const clock = parsePlantClock(timeText);
  if (clock === undefined) return { kind: 'error', field: 'time', message: timeMessage(options) };
  if (bounded) {
    if (dateText !== '') return checked(plantInstant(dateText, clock), dateText);
    for (const day of plantDaysBetween(min, max)) {
      const instant = plantInstant(day, clock);
      if (within(instant, min, max)) return { kind: 'ok', instant, day };
    }
    return { kind: 'error', field: 'time', message: rangeMessage(min, max) };
  }
  const day = parsePlantDate(dateText);
  if (day === undefined) return { kind: 'error', field: 'date', message: DATE_MESSAGE };
  return checked(plantInstant(day, clock), day);
}

const showSeconds = (instant: number, withSeconds: boolean): boolean =>
  withSeconds || instant % 60_000 !== 0;

/**
 * The boxes' texts for a value (empty for none). With both bounds the day stays unchosen (`''`)
 * when the time alone lands on it, so changing the time later moves the day with it (a night
 * shift's 23:15 and 00:05).
 */
function textsOf(
  value: string | null,
  options: ReadOptions & { readonly defaultDate: string | undefined },
): { readonly date: string; readonly time: string } {
  const bounded = options.min !== undefined && options.max !== undefined;
  const instant = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(instant)) {
    return {
      date: bounded || options.defaultDate === undefined ? '' : plantDateText(options.defaultDate),
      time: '',
    };
  }
  const time = plantClockText(instant, showSeconds(instant, options.withSeconds));
  if (!bounded) return { date: plantDateText(instant), time };
  const auto = readPlantTime('', time, options);
  const day = plantDayOf(instant);
  return { date: auto.kind === 'ok' && auto.day === day ? '' : day, time };
}

const ZONE_TEXT: Readonly<Record<PlantTimeVariant, string>> = {
  plant: `plant time in ${PLANT_TIME_ZONE}`,
  console: `simulation time in ${PLANT_TIME_ZONE}`,
};

const join = (...parts: (string | undefined | false)[]): string => parts.filter(Boolean).join(' ');

export function PlantTimeInput({
  label,
  name,
  value,
  onChange,
  withSeconds = false,
  min,
  max,
  required = false,
  testId,
  variant = 'plant',
  hint,
  error,
  defaultDate,
  disabled = false,
  size = 'md',
  className,
}: PlantTimeInputProps) {
  const bounded = min !== undefined && max !== undefined;
  const options: ReadOptions = { withSeconds, variant, min, max };
  const [texts, setTexts] = useState(() => textsOf(value, { ...options, defaultDate }));
  const [touched, setTouched] = useState(false);
  // The value last seen and last sent: a new value from the owner (a reset after a write) that is
  // not the one this input sent replaces what the boxes say.
  const [seen, setSeen] = useState(value);
  const [sent, setSent] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== sent) {
      setSent(value);
      setTexts(textsOf(value, { ...options, defaultDate }));
      setTouched(false);
    }
  }

  const reading = readPlantTime(texts.date, texts.time, options);
  const iso = reading.kind === 'ok' ? new Date(reading.instant).toISOString() : null;

  const update = (next: { readonly date: string; readonly time: string }) => {
    setTexts(next);
    const read = readPlantTime(next.date, next.time, options);
    const nextIso = read.kind === 'ok' ? new Date(read.instant).toISOString() : null;
    if (nextIso !== sent) {
      setSent(nextIso);
      onChange(nextIso);
    }
  };

  const base = useId();
  const dateId = `${base}-date`;
  const timeId = `${base}-time`;
  const hintId = `${base}-hint`;
  const utcId = `${base}-utc`;
  const errorId = `${base}-error`;
  const ownError = touched && reading.kind === 'error' ? reading : undefined;
  const message = ownError?.message ?? (error === '' ? undefined : error);
  const describedBy = join(
    hint === undefined || hint === null ? undefined : hintId,
    utcId,
    message === undefined ? undefined : errorId,
  );
  const dateInvalid =
    message !== undefined && (ownError === undefined || ownError.field === 'date');
  const timeInvalid =
    message !== undefined && (ownError === undefined || ownError.field === 'time');

  const onBlur = (event: FocusEvent<HTMLFieldSetElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setTouched(true);
    // Tidy what was typed into the input's own format (an ISO instant into date and time); a day
    // the bounds chose stays unchosen.
    if (reading.kind === 'ok') {
      setTexts({
        date: bounded ? texts.date : plantDateText(reading.instant),
        time: plantClockText(reading.instant, showSeconds(reading.instant, withSeconds)),
      });
    }
  };

  const days = bounded ? plantDaysBetween(min, max) : [];
  const shownDay = texts.date !== '' ? texts.date : reading.kind === 'ok' ? reading.day : days[0];
  const subLabel = 'text-xs font-medium text-ink-secondary';
  const formatHint = bounded
    ? `Time as ${withSeconds ? 'hh:mm:ss' : 'hh:mm'}.`
    : `Date as dd/mm/yyyy, time as ${withSeconds ? 'hh:mm:ss' : 'hh:mm'}${
        variant === 'console' ? ', or an ISO 8601 instant in the time box' : ''
      }.`;

  return (
    <fieldset
      className={join('flex min-w-0 flex-col gap-1', className)}
      disabled={disabled}
      onBlur={onBlur}
      data-value={iso ?? ''}
    >
      <legend className="mb-1 text-sm font-medium text-ink">
        {/* One parenthesis only: "Planned start (required), plant time in Europe/Istanbul". */}
        {`${label}${required ? ' (required)' : ''}, ${ZONE_TEXT[variant]}`}
      </legend>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={dateId} className={subLabel}>
            Date
          </label>
          {bounded ? (
            <SelectControl
              id={dateId}
              name={`${name}-date`}
              size={size}
              value={shownDay ?? ''}
              describedBy={describedBy}
              invalid={dateInvalid}
              data-testid={testId === undefined ? undefined : `${testId}-date`}
              onChange={(event) => {
                update({ date: event.target.value, time: texts.time });
              }}
            >
              {days.map((day) => (
                <option key={day} value={day}>
                  {plantDayLabel(day)}
                </option>
              ))}
            </SelectControl>
          ) : (
            <input
              id={dateId}
              name={`${name}-date`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="dd/mm/yyyy"
              value={texts.date}
              aria-describedby={describedBy}
              aria-invalid={dateInvalid || undefined}
              data-testid={testId === undefined ? undefined : `${testId}-date`}
              onChange={(event) => {
                update({ date: event.target.value, time: texts.time });
              }}
              className={join(controlClass({ size }), size === 'touch' ? 'w-44' : 'w-32')}
            />
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={timeId} className={subLabel}>
            Time
          </label>
          <input
            id={timeId}
            name={`${name}-time`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              variant === 'console'
                ? `${withSeconds ? 'hh:mm:ss' : 'hh:mm'} or ISO 8601`
                : withSeconds
                  ? 'hh:mm:ss'
                  : 'hh:mm'
            }
            value={texts.time}
            aria-describedby={describedBy}
            aria-invalid={timeInvalid || undefined}
            data-testid={testId}
            onChange={(event) => {
              update({ date: texts.date, time: event.target.value });
            }}
            className={join(
              controlClass({ size }),
              'tabular-nums',
              variant === 'console' ? 'w-64 max-w-full' : size === 'touch' ? 'w-36' : 'w-28',
            )}
          />
        </div>
      </div>
      {hint === undefined || hint === null ? null : <FieldHint id={hintId}>{hint}</FieldHint>}
      <p
        id={utcId}
        className="text-xs text-ink-secondary tabular-nums"
        data-testid={testId === undefined ? undefined : `${testId}-utc`}
      >
        {reading.kind === 'ok' ? `= ${utcInstantText(reading.instant)}` : formatHint}
      </p>
      {message === undefined ? null : <FieldError id={errorId}>{message}</FieldError>}
      <input type="hidden" name={name} value={iso ?? ''} />
    </fieldset>
  );
}
