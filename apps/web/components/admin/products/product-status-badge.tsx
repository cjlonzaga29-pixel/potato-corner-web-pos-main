import type { ProductStatus } from '@potato-corner/shared';
import { StatusBadge } from '@/components/shared/status-badge';

interface ProductStatusBadgeProps {
  status: ProductStatus;
}

export function ProductStatusBadge({ status }: ProductStatusBadgeProps) {
  return <StatusBadge status={status} type="product" />;
}
