/** A failed read with what the MES said (problem details) and a way to try again. */
export function QueryError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry?: () => void;
}) {
  const detail = error instanceof Error ? error.message : 'Unknown error';
  return (
    <div role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-red-950">
      <p className="font-semibold">Could not load {what}.</p>
      <p className="text-sm">{detail}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded border border-red-800 bg-white px-3 py-1 text-sm font-medium text-red-900 hover:bg-red-100"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
