import { causeWords } from '../domain/plant.ts';
import { Code } from './ui/code.tsx';
import { Missing } from './ui/format.tsx';

/**
 * A state's cause as words with its code beside it (design system 6.4, O-02): "No order
 * `NO-ORDER`". The code is left out where it says nothing more than the words ("Break", not
 * "Break `BREAK`"). No cause is an em dash with its reason.
 */
export function CauseText({ cause }: { readonly cause: string | null }) {
  if (cause === null) return <Missing reason="No cause reported" />;
  const words = causeWords(cause);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span>{words}</span>
      {words.toLowerCase() === cause.toLowerCase() ? null : (
        <>
          {' '}
          <Code className="text-ink-secondary">{cause}</Code>
        </>
      )}
    </span>
  );
}
