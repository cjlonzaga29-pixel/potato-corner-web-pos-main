import { LoadingSpinner } from './loading-spinner';

interface PageLoaderProps {
  message?: string;
}

/** Full-page overlay used during initial data loads and role-based redirects. */
export function PageLoader({ message }: PageLoaderProps) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm">
      <LoadingSpinner size="lg" />
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
