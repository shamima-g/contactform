'use client';

import { RouteGuard } from '@/components/route-guard';
import { Inbox } from '@/components/inbox';

/** Back-office inbox — Support Agent and Admin only (Stories 4–6). */
export default function InboxPage() {
  return (
    <RouteGuard allow={['Support Agent', 'Admin']}>
      <Inbox />
    </RouteGuard>
  );
}
