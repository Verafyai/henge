import type { ReactNode } from 'react';
import { cn } from './cn';

export type Tone = 'approved' | 'rejected' | 'pending' | 'appealed' | 'info' | 'neutral' | 'brand';

/** Status colors per SPEC 2.2, at the mockup's tint levels (text shades pass WCAG AA at 11px). */
const tones: Record<Tone, string> = {
  approved: 'bg-teal-50 text-teal-800 border-teal-200',
  brand: 'bg-teal-50 text-teal-800 border-teal-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
  appealed: 'bg-violet-50 text-violet-800 border-violet-200',
  info: 'bg-blue-50 text-blue-800 border-blue-200',
  neutral: 'bg-zinc-100 text-zinc-700 border-zinc-200',
};

/** Status chip. Color is never the only signal: chips always carry text. */
export function Chip({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide', tones[tone], className)}>
      {children}
    </span>
  );
}

/** Small pill with a live dot, used for the hero eyebrow. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 rounded-full border border-brand/30 bg-white/70 px-3 py-1 text-xs font-semibold text-teal-800', className)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
      {children}
    </span>
  );
}
