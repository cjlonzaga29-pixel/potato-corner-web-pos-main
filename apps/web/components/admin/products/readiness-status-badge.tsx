import { CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function ReadinessStatusBadge({ status }: { status: 'READY' | 'NOT_READY' }) {
  if (status === 'READY') {
    return (
      <Badge variant="active" className="gap-1">
        <CheckCircle2 className="h-3 w-3" /> Ready
      </Badge>
    );
  }
  return (
    <Badge variant="critical" className="gap-1">
      <XCircle className="h-3 w-3" /> Not Ready
    </Badge>
  );
}
