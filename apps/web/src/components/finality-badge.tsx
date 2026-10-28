import { Badge } from './ui/badge.tsx';
import { countOf } from '../domain/words.ts';

/**
 * The finality of a section's figures, shown once per scope in its header (design system 2.6,
 * E-03): Final is a neutral outline with a check, Provisional a neutral dashed outline; a revised
 * figure takes the `info` tone and keeps its outline, dashed while provisional. Revisions and written-off incidents follow the
 * word ("Final · revision 2 · 1 incident"). `data-finality` carries `final` or `provisional`.
 * The per-row flags with their explanations stay `StatusFlags` (`oee-ui.tsx`).
 */
export function FinalityBadge({
  final,
  revision = 0,
  incidents = 0,
  title,
  testId,
}: {
  readonly final: boolean;
  readonly revision?: number;
  readonly incidents?: number;
  readonly title?: string;
  readonly testId?: string;
}) {
  const parts = [final ? 'Final' : 'Provisional'];
  if (revision > 0) parts.push(`revision ${String(revision)}`);
  if (incidents > 0) parts.push(countOf(incidents, 'incident'));
  const revised = revision > 0;
  return (
    <Badge
      data-testid={testId}
      data-finality={final ? 'final' : 'provisional'}
      tone={revised ? 'info' : 'neutral'}
      variant={final ? 'outline' : 'dashed'}
      icon={final ? 'check' : undefined}
      title={title}
    >
      {parts.join(' · ')}
    </Badge>
  );
}
