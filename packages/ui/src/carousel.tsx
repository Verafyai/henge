'use client';

import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';

/**
 * Trending carousel (SPEC 6.1): 4 visible plus a peek, arrows, dots, keyboard
 * (Left and Right arrows) and swipe (native scroll snap). Auto advance is off.
 */
export function Carousel({ children, label, subtitle, className }: { children: ReactNode; label: string; subtitle?: string; className?: string }) {
  const track = useRef<HTMLDivElement>(null);
  const items = Children.toArray(children);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const p = Math.max(1, Math.ceil(el.scrollWidth / el.clientWidth - 0.05));
    setPages(p);
    const max = el.scrollWidth - el.clientWidth;
    setPage(max <= 0 ? 0 : Math.round((el.scrollLeft / max) * (p - 1)));
  }, []);

  useEffect(() => {
    measure();
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [measure]);

  const go = (target: number) => {
    const el = track.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(pages - 1, target));
    const max = el.scrollWidth - el.clientWidth;
    el.scrollTo({ left: pages <= 1 ? 0 : (max * clamped) / (pages - 1), behavior: 'smooth' });
    setPage(clamped);
  };

  const arrow = (dir: 'prev' | 'next') => (
    <button
      type="button"
      aria-label={dir === 'prev' ? 'Previous' : 'Next'}
      onClick={() => go(dir === 'prev' ? page - 1 : page + 1)}
      disabled={dir === 'prev' ? page === 0 : page >= pages - 1}
      className="grid size-10 place-items-center rounded-full border border-zinc-300 bg-white text-ink enabled:hover:border-brand enabled:hover:text-brand disabled:opacity-40"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4">
        <path fill="currentColor" d={dir === 'prev' ? 'M12.7 4.3 7 10l5.7 5.7-1.4 1.4L4.2 10l7.1-7.1z' : 'M7.3 4.3 13 10l-5.7 5.7 1.4 1.4 7.1-7.1-7.1-7.1z'} />
      </svg>
    </button>
  );

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          go(page + 1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          go(page - 1);
        }
      }}
      className={cn('focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand', className)}
    >
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-ink">{label}</h2>
          {subtitle && <p className="text-sm text-zinc-500">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {arrow('prev')}
          {arrow('next')}
        </div>
      </div>
      <div ref={track} className="flex snap-x snap-mandatory gap-6 overflow-x-auto scroll-smooth pb-2 [scrollbar-width:none]">
        {items.map((child, i) => (
          <div key={i} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${items.length}`} className="w-[85%] shrink-0 snap-start sm:w-[296px]">
            {child}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-center">
        {Array.from({ length: pages }, (_, i) => (
          <button key={i} type="button" aria-label={`Go to page ${i + 1}`} aria-current={i === page ? 'true' : undefined} onClick={() => go(i)} className="grid h-10 w-6 place-items-center">
            <span className={cn('block h-1.5 rounded-full transition-all', i === page ? 'w-5 bg-brand' : 'w-1.5 bg-zinc-300')} />
          </button>
        ))}
      </div>
    </div>
  );
}
