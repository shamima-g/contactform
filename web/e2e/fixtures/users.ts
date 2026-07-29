/**
 * Mock sign-in identities for e2e specs. Auth is simulated client-side, so
 * these are the seeded accounts (not real credentials). Imported via a relative
 * path per testing-policy so Playwright needs no `@/` alias plumbing.
 */
import { SEEDED_USERS } from '../../src/mocks/data/identity';

const byRole = (role: string) => {
  const user = SEEDED_USERS.find((u) => u.role === role);
  if (!user) throw new Error(`No seeded user for role ${role}`);
  return { email: user.email, password: user.password, name: user.name };
};

export const visitorUser = byRole('Visitor');
export const agentUser = byRole('Support Agent');
export const adminUser = byRole('Admin');
