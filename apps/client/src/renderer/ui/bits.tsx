import { cn } from '@swarm-explorer/ui';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn('mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500', className)}>{children}</h2>;
}

export function Empty({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-600', className)}>
      <p className="font-semibold text-ink">{title}</p>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

type Variant = 'primary' | 'outline' | 'quiet';
export function Btn({ variant = 'primary', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'primary' && 'bg-brand text-white hover:bg-brand-hover',
        variant === 'outline' && 'border-2 border-brand text-brand hover:bg-teal-50',
        variant === 'quiet' && 'border border-zinc-300 text-ink hover:border-brand',
        className,
      )}
    />
  );
}
