import { useState } from 'react';
import { useQuietErrors } from './query-error.tsx';
import { ErrorState } from './ui/error-state.tsx';

/**
 * The screen-level error model (#394; design system 4.11 and 10): a screen raises at most one
 * error alert, however many of its reads failed.
 *
 * - Nothing of the screen loaded: one `ScreenError` names every read that failed, with one "Try
 *   again" that reads each of them again; the sections are not drawn.
 * - The screen loaded and one section's read failed: that section says so itself, under its
 *   heading, as before (design system 10, partial error).
 * - The screen loaded and several reads failed: one `ScreenError` under the page header names them
 *   all; each failed section says it in one quiet line (`SectionError`), not announced again.
 * - While nothing loaded and a read is still on its way, nothing is said yet (the screen shows its
 *   skeletons): the one error comes once every read has answered, not an alert that turns into
 *   another a moment later.
 *
 * A screen lists its reads, each of a kind:
 * - `base`: what the screen needs before it can show anything (the shifts, the alarm scopes, the
 *   reason codes): its answer alone is not the screen having loaded, and its failure is said by
 *   the screen's error;
 * - `main`: content without a section of its own (the shift's OEE, which every section is drawn
 *   from; the counts of the other tabs): its failure is said by the screen's error;
 * - `section`: content shown in a section of its own (the floods, the bad actors).
 */
export type ReadKind = 'base' | 'main' | 'section';

export interface ScreenRead {
  /** Unique within the screen (several reads may share `what`: each tile's "the KPIs"). */
  readonly key: string;
  /** What it reads, as "Could not load …" goes on: "the equipment". */
  readonly what: string;
  readonly kind: ReadKind;
  /** Its last attempt failed (with or without an earlier answer kept). */
  readonly failed: boolean;
  readonly error: unknown;
  /** An answer is there to show. */
  readonly hasData: boolean;
  /**
   * Its first load is on its way, with nothing to show yet (a disabled read is neither this nor
   * failed).
   */
  readonly loading: boolean;
  /**
   * Read again after a failure, with nothing to show and no answer yet: TanStack Query (v5) sets
   * such a query back to `pending` with no error while it fetches (a poll, a retry). The screen's
   * errors keep its last failure meanwhile (`useScreenErrors`), so the error does not flap.
   */
  readonly retrying: boolean;
  readonly retry: () => void;
}

/** The parts of a TanStack Query result a `ScreenRead` is made of. */
export interface QueryLike {
  readonly status: 'pending' | 'error' | 'success';
  readonly fetchStatus: 'fetching' | 'paused' | 'idle';
  readonly data: unknown;
  readonly error: unknown;
  /** How often it failed since it was created: more than none, a fetch now is a re-read. */
  readonly errorUpdateCount: number;
  readonly refetch: () => unknown;
}

/** A query as one of the screen's reads. */
export function queryRead(
  what: string,
  query: QueryLike,
  kind: ReadKind,
  key: string = what,
): ScreenRead {
  const fetching = query.status === 'pending' && query.fetchStatus !== 'idle';
  return {
    key,
    what,
    kind,
    failed: query.status === 'error',
    error: query.error,
    hasData: query.data !== undefined,
    loading: fetching && query.errorUpdateCount === 0,
    retrying: fetching && query.errorUpdateCount > 0,
    retry: () => {
      void query.refetch();
    },
  };
}

/** The shift picker's reads (`useShiftSelection`): the screen's `base`. */
export function selectionRead(selection: {
  readonly pending: boolean;
  readonly error: unknown;
  readonly current: unknown;
  /** One of its reads is read again after a failure, with no answer yet. */
  readonly retrying: boolean;
  readonly retry: () => void;
}): ScreenRead {
  const failed = selection.error !== null && selection.error !== undefined;
  const retrying = !failed && selection.retrying;
  return {
    key: 'the shifts',
    what: 'the shifts',
    kind: 'base',
    failed,
    error: selection.error,
    hasData: selection.current !== undefined,
    loading: selection.pending && !failed && !retrying,
    retrying,
    retry: selection.retry,
  };
}

/**
 * The screen's errors (`screenErrors`), each read's last failure kept while it is read again
 * (`retrying`): a polled or retried read that failed with nothing to show stays failed, with the
 * same error, until it answers, so the one error neither loses a name nor goes away and comes
 * back on every poll. A re-read with no failure seen by this screen (the screen opened on a query
 * that had failed before) counts as loading.
 */
export function useScreenErrors(reads: readonly ScreenRead[]): ScreenErrors {
  // The last failure of each read that is being read again, by key (state set while rendering, the
  // way React derives state from props: the render that saw it uses `next` at once).
  const [last, setLast] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  const next = new Map(last);
  const kept = reads.map((read): ScreenRead => {
    if (read.failed) {
      next.set(read.key, read.error);
      return read;
    }
    if (read.retrying && next.has(read.key)) {
      return { ...read, failed: true, error: next.get(read.key), retrying: false };
    }
    if (!read.retrying) next.delete(read.key);
    return read;
  });
  const changed =
    next.size !== last.size || [...next].some(([key, error]) => last.get(key) !== error);
  if (changed) setLast(next);
  return screenErrors(kept);
}

export interface ScreenErrors {
  /** The failed reads the screen's one error names, in the order given; empty: none. */
  readonly summary: readonly ScreenRead[];
  /** Whether nothing of the screen's content loaded: the error stands for the whole screen. */
  readonly whole: boolean;
  /** Whether this read's section shows an error in place of its content (`SectionError`). */
  readonly inSection: (key: string) => boolean;
  /**
   * How a section says its read failed: `own`, its own error (the only failure of a screen that
   * loaded); `named`, a quiet line, the screen's error naming it; nothing when it did not fail.
   */
  readonly section: (
    key: string,
  ) => { readonly read: ScreenRead; readonly own: boolean } | undefined;
}

export function screenErrors(reads: readonly ScreenRead[]): ScreenErrors {
  const loaded = reads.some((read) => read.kind !== 'base' && read.hasData);
  // Until something loaded, a failure waits for the reads still on their way; once something
  // has, what failed is said at once (a read loading later, another tab's, hides nothing).
  // A re-read whose failure was not kept counts as a first load.
  const waiting = !loaded && reads.some((read) => read.loading || (read.retrying && !read.failed));
  const failed = waiting ? [] : reads.filter((read) => read.failed);
  const only = failed.length === 1 ? failed[0] : undefined;
  const own = loaded && only?.kind === 'section' ? only : undefined;
  const sections = new Map<string, { read: ScreenRead; own: boolean }>();
  if (own) sections.set(own.key, { read: own, own: true });
  else if (loaded) {
    for (const read of failed) {
      if (read.kind === 'section') sections.set(read.key, { read, own: false });
    }
  }
  const summary = own ? [] : failed;
  return {
    summary,
    whole: !loaded && summary.length > 0,
    inSection: (key) => sections.has(key),
    section: (key) => sections.get(key),
  };
}

/** "a", "a and b", "a, b and c": each name once. */
export function namesText(names: readonly string[]): string {
  const unique = [...new Set(names)];
  const last = unique.pop();
  if (last === undefined) return '';
  return unique.length === 0 ? last : `${unique.join(', ')} and ${last}`;
}

/**
 * The screen's one error (#394): an `ErrorState` naming every read in `errors.summary` ("Could not
 * load the shifts, the equipment and the shift's OEE."), each one's detail said once, and one "Try
 * again" that reads each of them again. Announced as `ErrorState` is (`role="alert"`, no focus
 * move), and quiet under the offline bar as `QueryError` is. Nothing when no read is in it.
 */
export function ScreenError({
  errors,
  testId,
  className,
}: {
  readonly errors: ScreenErrors;
  readonly testId?: string;
  /** A frame around the error (its spacing in the page), drawn only with the error. */
  readonly className?: string;
}) {
  const failed = errors.summary;
  const quiet = useQuietErrors(failed.map((read) => read.error));
  const first = failed[0];
  if (first === undefined) return null;
  const error = (
    <ErrorState
      what={namesText(failed.map((read) => read.what))}
      error={first.error}
      failures={failed}
      onRetry={() => {
        for (const read of failed) read.retry();
      }}
      quiet={quiet}
      testId={testId}
    />
  );
  return className === undefined ? error : <div className={className}>{error}</div>;
}

/**
 * A section's failed read (#394): its own error (announced, with "Try again", quiet under the
 * offline bar as `QueryError` is) when it is the screen's only failure, else one quiet line, the
 * screen's error naming it. Nothing when the read did not fail.
 */
export function SectionError({
  errors,
  readKey,
}: {
  readonly errors: ScreenErrors;
  readonly readKey: string;
}) {
  const shown = errors.section(readKey);
  const quiet = useQuietErrors(shown ? [shown.read.error] : []);
  if (!shown) return null;
  const { read, own } = shown;
  return (
    // A quiet line has no "Try again": the screen's error, which names it, has the one.
    <ErrorState what={read.what} error={read.error} onRetry={read.retry} quiet={quiet || !own} />
  );
}
