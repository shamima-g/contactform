/**
 * Auth API module — the boundary the session provider calls.
 *
 * Auth is simulated client-side (project.md §Authentication): credentials are
 * validated against the seeded users. No real network, no cookies from a
 * server — the session is persisted by the SessionProvider.
 */
import type { SessionUser } from '@/types/domain';
import { findByCredentials } from '@/mocks/data/identity';

const LATENCY_MS = 60;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Resolve with the signed-in identity, or reject with an AuthError. */
export function signIn(email: string, password: string): Promise<SessionUser> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const user = findByCredentials(email, password);
      if (user) resolve(user);
      else reject(new AuthError('Incorrect email or password'));
    }, LATENCY_MS);
  });
}
