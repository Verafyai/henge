'use client';

import type { ReactNode } from 'react';

/** GET form that submits when a select changes. The Apply button keeps it working without JS. */
export function AutoSubmitForm({ action, label, children }: { action: string; label: string; children: ReactNode }) {
  return (
    <form method="get" action={action} aria-label={label} onChange={(e) => e.currentTarget.requestSubmit()} className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      {children}
    </form>
  );
}
