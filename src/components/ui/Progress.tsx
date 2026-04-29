import * as React from 'react';

import { cn } from '../../lib/utils';

type ProgressProps = React.HTMLAttributes<HTMLDivElement> & {
  value: number;
};

export function Progress({ value, className, ...props }: ProgressProps) {
  return (
    <div
      className={cn('relative h-3 w-full overflow-hidden rounded-full bg-secondary', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      {...props}
    >
      <div
        className="h-full rounded-full bg-linear-to-r from-amber-700 to-emerald-700 transition-all"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
