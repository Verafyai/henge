import type { ReactNode } from 'react';
import { cn } from './cn';

export type TabItem = { key: string; label: string; href: string; count?: number };

/** Navigation tabs (each tab is a route). Uses aria-current for the active tab. */
export function Tabs({ items, active, className, label = 'Sections' }: { items: TabItem[]; active: string; className?: string; label?: string }) {
  return (
    <nav aria-label={label} className={cn('border-b border-zinc-200', className)}>
      <ul className="mx-auto flex max-w-[1280px] gap-7 overflow-x-auto px-4 text-sm [scrollbar-width:none] sm:px-8">
        {items.map((t) => {
          const isActive = t.key === active;
          return (
            <li key={t.key}>
              <a
                href={t.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-1.5 whitespace-nowrap border-b-2 py-3.5',
                  isActive ? 'border-brand font-semibold text-brand' : 'border-transparent text-zinc-600 hover:text-ink',
                )}
              >
                {t.label}
                {t.count !== undefined && <span>{t.count}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function TabPanel({ children }: { children: ReactNode }) {
  return <div className="pt-6">{children}</div>;
}
