'use client';

/**
 * The signed-in application shell: a header showing the app name, the current
 * user + role, role-appropriate navigation, and a Sign out control. Wraps every
 * protected page's content.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import type { Role, SessionUser } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useSession } from '@/lib/auth/session';

interface NavLink {
  href: string;
  label: string;
}

const NAV_BY_ROLE: Record<Role, NavLink[]> = {
  Visitor: [
    { href: '/contact', label: 'Contact us' },
    { href: '/my-submissions', label: 'My submissions' },
  ],
  'Support Agent': [{ href: '/inbox', label: 'Inbox' }],
  Admin: [{ href: '/inbox', label: 'Inbox' }],
};

export function AppShell({
  user,
  children,
}: {
  user: SessionUser;
  children: React.ReactNode;
}) {
  const { signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const links = NAV_BY_ROLE[user.role];

  const handleSignOut = () => {
    signOut();
    router.replace('/');
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="text-lg font-semibold">Contact &amp; Enquiries</span>
          <nav className="flex items-center gap-1" aria-label="Primary">
            {links.map((link) => {
              const active = pathname === link.href;
              return (
                <Button
                  key={link.href}
                  asChild
                  variant={active ? 'secondary' : 'ghost'}
                  size="sm"
                >
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                  >
                    {link.label}
                  </Link>
                </Button>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {user.name}
            </span>
            <Badge variant="outline">{user.role}</Badge>
            <Button variant="outline" size="sm" onClick={handleSignOut}>
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
