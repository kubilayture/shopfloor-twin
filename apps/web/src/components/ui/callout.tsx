import type { ReactNode } from 'react';
import type { DataAttributes } from './badge.tsx';
import { Icon, type IconName } from './icons.tsx';
import type { Tone } from './tokens.ts';

/**
 * A page-level message (UX-1c, #315; design system 4.13): a refused write, the idle warning, a
 * one-line "Your role cannot change orders". Soft fill in its tone, a border, a glyph and the
 * words; `role` only when the caller wants it announced (`alert` for a refused write, `status`
 * for a polite note): a callout that is just there on load needs none. `data-*` pass through.
 * `size="touch"` is the operator terminal's (UX-7, #330): read at arm's length, 18 px text, a 20 px
 * title and a 24 px glyph.
 */

export const CALLOUT_LOOK: Readonly<Record<Tone, string>> = {
  neutral: 'bg-neutral-soft text-neutral-ink border-neutral-border',
  info: 'bg-info-soft text-info-ink border-info-border',
  ok: 'bg-ok-soft text-ok-ink border-ok-border',
  warn: 'bg-warn-soft text-warn-ink border-warn-border',
  caution: 'bg-caution-soft text-caution-ink border-caution-border',
  alarm: 'bg-alarm-soft text-alarm-ink border-alarm-border',
};

const GLYPH: Readonly<Record<Tone, IconName>> = {
  neutral: 'info',
  info: 'info',
  ok: 'check',
  warn: 'alert',
  caution: 'alert',
  alarm: 'alert',
};

/** Padding, text and title size, and the glyph per size; written out in full for Tailwind. */
const SIZE = {
  md: { frame: 'gap-2 p-3 text-sm', title: 'font-semibold', icon: 16 },
  touch: { frame: 'gap-3 p-4 text-lg', title: 'text-xl font-semibold', icon: 24 },
} as const;

export interface CalloutProps extends DataAttributes {
  readonly tone: Tone;
  readonly size?: 'md' | 'touch';
  readonly title?: ReactNode;
  readonly role?: 'alert' | 'status';
  readonly className?: string;
  readonly children?: ReactNode;
}

export function Callout({
  tone,
  size = 'md',
  title,
  role,
  className,
  children,
  ...data
}: CalloutProps) {
  const look = SIZE[size];
  return (
    <div
      {...data}
      role={role}
      className={`flex rounded-md border ${look.frame} ${CALLOUT_LOOK[tone]}${className ? ` ${className}` : ''}`}
    >
      <Icon name={GLYPH[tone]} size={look.icon} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        {title === undefined ? null : <p className={look.title}>{title}</p>}
        {children === undefined ? null : (
          <div className={title === undefined ? '' : 'mt-1'}>{children}</div>
        )}
      </div>
    </div>
  );
}
