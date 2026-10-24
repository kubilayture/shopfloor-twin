/**
 * The design system's six tones (2.3) and the glyphs the domain names for its states (2.4, 2.6),
 * as plain types with no React: `domain/*` maps values to them, `components/ui/*` draws them
 * (`tokens.ts` re-exports `TONES` and `Tone`; `icons.tsx` has an icon for every `Glyph`, which the
 * badges' types check).
 */
export const TONES = ['neutral', 'info', 'ok', 'warn', 'caution', 'alarm'] as const;
export type Tone = (typeof TONES)[number];

/** The glyphs of the machine states (design system 2.4); each is an icon of `icons.tsx`. */
export type Glyph =
  | 'play'
  | 'rotate'
  | 'pause'
  | 'wrench'
  | 'circle'
  | 'triangle-left'
  | 'play-bar'
  | 'stop'
  | 'close'
  | 'question';
