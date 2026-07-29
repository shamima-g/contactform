/**
 * Seeded identities — the single source of truth for who can sign in and what
 * role they get. Consumed by the app's simulated auth, the in-memory store's
 * ownership scoping, and both test layers.
 *
 * Import rules (testing-policy § Mock data): types via `import type` only,
 * siblings via relative path — so this module is importable from the e2e layer
 * without `@/` alias plumbing.
 */
import type { Role, SessionUser, User } from '@/types/domain';

export const SEEDED_USERS: User[] = [
  {
    email: 'visitor@example.com',
    password: 'Test123',
    role: 'Visitor',
    name: 'Val Visitor',
  },
  {
    email: 'agent@example.com',
    password: 'Test123',
    role: 'Support Agent',
    name: 'Sam Agent',
  },
  {
    email: 'admin@example.com',
    password: 'Test123',
    role: 'Admin',
    name: 'Ada Admin',
  },
];

/** The signed-in identity (no password) for a given role — one per role. */
export function userInfoFor(role: Role): SessionUser {
  const user = SEEDED_USERS.find((u) => u.role === role);
  if (!user) throw new Error(`No seeded user for role ${role}`);
  return { email: user.email, role: user.role, name: user.name };
}

/** Validate credentials against the seeded users. Returns the session identity or null. */
export function findByCredentials(
  email: string,
  password: string,
): SessionUser | null {
  const match = SEEDED_USERS.find(
    (u) =>
      u.email.toLowerCase() === email.trim().toLowerCase() &&
      u.password === password,
  );
  return match
    ? { email: match.email, role: match.role, name: match.name }
    : null;
}
