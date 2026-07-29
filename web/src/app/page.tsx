'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { SignInForm } from '@/components/sign-in-form';
import { useSession } from '@/lib/auth/session';
import { roleHome } from '@/lib/auth/access';

/**
 * App root. Signed-out users see the sign-in screen; signed-in users are sent
 * to their role's home. This replaces the starter-template welcome page so the
 * root is gated (Story 1, AC-3).
 */
export default function HomePage() {
  const { user } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (user) {
      router.replace(roleHome(user.role));
    }
  }, [user, router]);

  if (user === undefined) {
    return (
      <div
        className="flex min-h-screen items-center justify-center text-muted-foreground"
        role="status"
      >
        Loading…
      </div>
    );
  }

  if (user) {
    // Redirect in-flight — don't flash the sign-in form.
    return null;
  }

  return <SignInForm />;
}
