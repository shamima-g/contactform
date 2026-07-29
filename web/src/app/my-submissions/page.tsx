'use client';

import { RouteGuard } from '@/components/route-guard';
import { MySubmissions } from '@/components/my-submissions';

/** A Visitor's own submissions — Visitor only (Story 3). */
export default function MySubmissionsPage() {
  return (
    <RouteGuard allow={['Visitor']}>
      <MySubmissions />
    </RouteGuard>
  );
}
