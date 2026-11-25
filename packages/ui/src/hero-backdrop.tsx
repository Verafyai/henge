import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * SPEC 2.2 hero rule, as built in the mockups: the wave SVG is masked from
 * opaque to transparent top to bottom, and a soft white radial overlay sits
 * behind the text. The page background shows through, so there is no seam.
 */
export function HeroBackdrop({ children, src = '/brand/waves.svg', className, faded = false }: { children: ReactNode; src?: string; className?: string; faded?: boolean }) {
  const mask = 'linear-gradient(to bottom, #000 0%, #000 45%, transparent 100%)';
  return (
    <section className={cn('relative overflow-hidden', className)} data-testid="hero">
      <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0 overflow-hidden', faded && 'opacity-60')}>
        <img
          src={src}
          alt=""
          fetchPriority="high"
          className="absolute left-1/2 top-0 h-full w-[1600px] max-w-none -translate-x-1/2 object-cover"
          style={{ maskImage: mask, WebkitMaskImage: mask }}
        />
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(60% 55% at 50% 45%, rgba(255,255,255,.85) 0, rgba(255,255,255,.35) 50%, rgba(255,255,255,0) 75%)' }}
        />
      </div>
      <div className="relative">{children}</div>
    </section>
  );
}
