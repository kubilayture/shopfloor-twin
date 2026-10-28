import { useEffect, useState } from 'react';

/**
 * A loading placeholder in the content's own shape (UX-1e, #317; design system 4.11, G-19): a
 * table skeleton with its header and five grey rows, a stat skeleton the height of the figure,
 * so nothing jumps when the data arrives. It holds its final size from the first render.
 *
 * `role="status"` with the screen's loading text, visually hidden ("Loading OEE…", exactly as
 * today, so tests and screen readers find the same words), present at once. The grey shapes show
 * only after `delayMs` (300 ms): a fast load shows nothing rather than a flash. They shimmer
 * only without `prefers-reduced-motion`.
 */
export type SkeletonShape = 'text' | 'stat' | 'table' | 'chart' | 'card';

export interface SkeletonProps {
  readonly shape: SkeletonShape;
  /** Lines of `text`, body rows of `table` (5 by default for a table, 3 for text). */
  readonly rows?: number;
  /**
   * The loading text, verbatim: "Loading OEE…". Without it the skeleton is a decorative part of
   * a loading state whose label another skeleton carries (no `role`, hidden from assistive
   * technology), so a page in its own shape has one status, not one per block.
   */
  readonly label?: string;
  /** The shape repeated this many times (a grid of cards), laid out by `gridClassName`. */
  readonly count?: number;
  readonly gridClassName?: string;
  readonly delayMs?: number;
  readonly testId?: string | undefined;
  readonly className?: string;
}

export const SKELETON_DELAY_MS = 300;

const BLOCK = 'rounded-sm bg-line-subtle';
/** Text line widths, repeated: a paragraph's ragged edge, the last line short. */
const WIDTHS = ['w-full', 'w-11/12', 'w-4/5', 'w-5/6'] as const;

function Lines({ rows }: { readonly rows: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={`h-4 ${BLOCK} ${i === rows - 1 && rows > 1 ? 'w-3/5' : (WIDTHS[i % WIDTHS.length] ?? 'w-full')}`}
        />
      ))}
    </div>
  );
}

function Shape({ shape, rows }: { readonly shape: SkeletonShape; readonly rows: number }) {
  switch (shape) {
    case 'text':
      return <Lines rows={rows} />;
    case 'stat':
      return (
        <div className="flex flex-col gap-2">
          <div className={`h-3 w-24 ${BLOCK}`} />
          <div className={`h-8 w-32 ${BLOCK}`} />
        </div>
      );
    case 'table':
      return (
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="flex h-9 items-center gap-6 border-b border-line bg-surface-sunken px-3">
            <div className={`h-3 w-1/4 ${BLOCK}`} />
            <div className={`h-3 w-1/5 ${BLOCK}`} />
            <div className={`h-3 w-1/6 ${BLOCK}`} />
          </div>
          {Array.from({ length: rows }, (_, i) => (
            <div
              key={i}
              className="flex h-10 items-center gap-6 border-b border-line-subtle px-3 last:border-b-0"
            >
              <div className={`h-3 w-1/4 ${BLOCK}`} />
              <div className={`h-3 w-1/5 ${BLOCK}`} />
              <div className={`h-3 w-1/6 ${BLOCK}`} />
            </div>
          ))}
        </div>
      );
    case 'chart':
      return <div className={`h-64 w-full ${BLOCK}`} />;
    case 'card':
      return (
        <div className="rounded-lg border border-line bg-surface p-5">
          <div className={`mb-4 h-5 w-1/3 ${BLOCK}`} />
          <Lines rows={3} />
        </div>
      );
  }
}

export function Skeleton({
  shape,
  rows,
  label,
  count = 1,
  gridClassName,
  delayMs = SKELETON_DELAY_MS,
  testId,
  className,
}: SkeletonProps) {
  const [shown, setShown] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return undefined;
    const timer = setTimeout(() => {
      setShown(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [delayMs]);
  const one = <Shape shape={shape} rows={rows ?? (shape === 'table' ? 5 : 3)} />;
  const blocks =
    count <= 1 ? (
      one
    ) : (
      <div className={gridClassName}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i}>{one}</div>
        ))}
      </div>
    );
  return (
    <div
      {...(label === undefined ? { 'aria-hidden': true } : { role: 'status' })}
      data-testid={testId}
      data-shape={shape}
      data-shown={shown}
      className={className}
    >
      {label === undefined ? null : <span className="sr-only">{label}</span>}
      <div aria-hidden="true" className={shown ? 'motion-safe:animate-pulse' : 'invisible'}>
        {blocks}
      </div>
    </div>
  );
}
