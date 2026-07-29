'use client';

import { RouteGuard } from '@/components/route-guard';
import { ContactForm } from '@/components/contact-form';

/** Public contact form — Visitor only (Story 2). */
export default function ContactPage() {
  return (
    <RouteGuard allow={['Visitor']}>
      <ContactForm />
    </RouteGuard>
  );
}
