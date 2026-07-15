import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface NotFoundStateProps {
  title?: string;
  description?: string;
  backHref?: string;
}

/** Used when a specific record (product, employee, branch) isn't found. */
export function NotFoundState({
  title = 'Not found',
  description = "The record you're looking for doesn't exist or has been removed.",
  backHref,
}: NotFoundStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="h-6 w-6" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {backHref && (
        <Button variant="outline" size="sm" asChild>
          <Link href={backHref}>Go back</Link>
        </Button>
      )}
    </div>
  );
}
