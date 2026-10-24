import { Badge } from './ui/badge.tsx';

export type LossKind = 'own' | 'external';

const LOSS_TEXT: Readonly<Record<LossKind, string>> = { own: 'Own', external: 'External' };

/**
 * Whether a downtime is the machine's own loss or caused outside it (starved, blocked, a planned
 * stop upstream) (design system 4.2, D-02): own is `warn` soft, external a neutral outline.
 * `data-kind` carries the raw value.
 */
export function LossBadge({ kind, testId }: { readonly kind: LossKind; readonly testId?: string }) {
  return (
    <Badge
      data-testid={testId}
      data-kind={kind}
      tone={kind === 'own' ? 'warn' : 'neutral'}
      variant={kind === 'own' ? 'soft' : 'outline'}
    >
      {LOSS_TEXT[kind]}
    </Badge>
  );
}
