/**
 * Role-based access control for routes — the single source of truth for which
 * roles may see which page, and where each role lands after sign-in.
 */
import type { Role } from '@/types/domain';

/** Protected routes → the roles allowed to view them. */
export const ROUTE_ACCESS: Record<string, Role[]> = {
  '/contact': ['Visitor'],
  '/my-submissions': ['Visitor'],
  '/inbox': ['Support Agent', 'Admin'],
};

/** Where each role lands after signing in. */
export function roleHome(role: Role): string {
  return role === 'Visitor' ? '/contact' : '/inbox';
}

/** Whether `role` may access `path`. Unlisted paths are open to any signed-in user. */
export function canAccess(role: Role, path: string): boolean {
  const allowed = ROUTE_ACCESS[path];
  return allowed ? allowed.includes(role) : true;
}
