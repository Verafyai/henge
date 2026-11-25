import { cn } from './cn';

export type Step = { key: string; label: string; href?: string; state: 'done' | 'current' | 'upcoming' };

/** Vertical wizard stepper. Completed steps link back; upcoming steps are not reachable. */
export function Stepper({ steps, className }: { steps: Step[]; className?: string }) {
  return (
    <ol className={cn('space-y-1', className)} aria-label="Steps">
      {steps.map((s, i) => {
        const body = (
          <>
            <span
              aria-hidden="true"
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                s.state === 'done' && 'bg-brand text-white',
                s.state === 'current' && 'bg-white text-brand ring-2 ring-brand',
                s.state === 'upcoming' && 'bg-fill text-ink-muted',
              )}
            >
              {s.state === 'done' ? '✓' : i + 1}
            </span>
            <span className={cn('text-sm', s.state === 'current' ? 'font-semibold text-ink' : 'text-ink-2')}>{s.label}</span>
            <span className="sr-only">{s.state === 'done' ? '(completed)' : s.state === 'current' ? '(current step)' : ''}</span>
          </>
        );
        return (
          <li key={s.key}>
            {s.state === 'done' && s.href ? (
              <a href={s.href} className="flex min-h-10 items-center gap-3 rounded-btn px-2 hover:bg-fill">
                {body}
              </a>
            ) : (
              <div aria-current={s.state === 'current' ? 'step' : undefined} className="flex min-h-10 items-center gap-3 px-2">
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
