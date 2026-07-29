'use client';

/**
 * Client-side route guard for protected pages.
 *
 * - While the session is loading, renders a minimal placeholder.
 * - Signed out → redirects to the sign-in screen (`/`).
 * - Signed in but role not allowed → renders the permission-denied banner
 *   inside the shell (the user stays on the URL, per R3).
 * - Otherwise renders the page inside the app shell.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Role } from '@/types/domain';
import { useSession } from '@/lib/auth/session';
import { AppShell } from '@/components/app-shell';
import { PermissionDenied } from '@/components/permission-denied';

export function RouteGuard({
  allow,
  children,
}: {
  allow: Role[];
  children: React.ReactNode;
}) {
  const { user } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (user === null) {
      router.replace('/');
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

  if (user === null) {
    // Redirect is in-flight; render nothing so the protected content never flashes.
    return null;
  }

  if (!allow.includes(user.role)) {
    return (
      <AppShell user={user}>
        <PermissionDenied />
      </AppShell>
    );
  }

  return <AppShell user={user}>{children}</AppShell>;
}
