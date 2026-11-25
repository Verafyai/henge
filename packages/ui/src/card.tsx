import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-card border border-line bg-surface', className)} {...rest} />;
}

/** Feature card: fill background with a 2px teal-700 border (SPEC 2.2). */
export function FeatureCard({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-card border-2 border-brand bg-fill', className)} {...rest} />;
}
