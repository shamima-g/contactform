import type { Status } from '@/types/domain';
import { Badge } from '@/components/ui/badge';

const VARIANT: Record<Status, 'secondary' | 'default' | 'outline'> = {
  New: 'secondary',
  'In Progress': 'default',
  Resolved: 'outline',
};

/** Consistent status pill used across the Visitor and back-office views. */
export function StatusBadge({ status }: { status: Status }) {
  return <Badge variant={VARIANT[status]}>{status}</Badge>;
}
