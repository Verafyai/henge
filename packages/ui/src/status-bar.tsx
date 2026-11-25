import type { ReactNode } from 'react';
import { cn } from './cn';

export type StatusItem = { key: string; value: ReactNode };
export type SwarmState = { label: string; tone: 'active' | 'paused' | 'idle' | 'offline'; detail?: ReactNode };

/**
 * Persistent bottom status bar for the desktop client (ADDENDUM A4.2,
 * client-store.png): swarm state, current task, progress, caps, spend, action.
 */
export function StatusBar({
  state,
  progress,
  items,
  note,
  action,
  className,
}: {
  state: SwarmState;
  progress?: number;
  items: StatusItem[];
  note?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <footer
      role="status"
      aria-label="Node status"
      className={cn('flex h-11 shrink-0 items-center gap-5 whitespace-nowrap bg-bar px-4 text-xs text-bar-ink', className)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full',
            state.tone === 'active' && 'bg-live',
            state.tone === 'paused' && 'bg-amber-400',
            state.tone === 'idle' && 'bg-bar-line',
            state.tone === 'offline' && 'bg-red-400',
          )}
        />
        <b className="whitespace-nowrap font-semibold text-white">{state.label}</b>
        {state.detail && <span className="truncate text-bar-muted">· {state.detail}</span>}
      </span>
      {progress !== undefined && (
        <span
          role="progressbar"
          aria-label="Current task progress"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1.5 w-40 shrink-0 overflow-hidden rounded-full bg-bar-track"
        >
          <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </span>
      )}
      {items.map((it) => (
        <span key={it.key} className="shrink-0 whitespace-nowrap">
          {it.value}
        </span>
      ))}
      <span className="ml-auto flex shrink-0 items-center gap-4">
        {note && <span className="text-bar-note">{note}</span>}
        {action}
      </span>
    </footer>
  );
}
