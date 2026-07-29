'use client';

/**
 * Client-side simulated session (project.md §Authentication — auth is simulated
 * client-side, no real backend). The signed-in identity is persisted to
 * localStorage and exposed via an external store consumed with
 * `useSyncExternalStore`, so it survives client-side navigation and reloads and
 * hydrates cleanly (server + first paint render the "loading" snapshot, then
 * React syncs to the stored value).
 */
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from 'react';
import type { SessionUser } from '@/types/domain';
import { signIn as apiSignIn } from '@/lib/api/auth';

const STORAGE_KEY = 'contact-enquiry-session';

// --- External store (lives outside React) -------------------------------

type SessionValue = SessionUser | null | undefined; // undefined = still loading

const listeners = new Set<() => void>();
let cache: SessionValue = undefined;
let hasRead = false;

function readStored(): SessionUser | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

function refresh(): void {
  cache = readStored();
  hasRead = true;
  listeners.forEach((l) => l());
}

function getSnapshot(): SessionValue {
  if (!hasRead) {
    cache = readStored();
    hasRead = true;
  }
  return cache;
}

function getServerSnapshot(): SessionValue {
  return undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Re-sync on cross-tab writes and bfcache restore (browser Back), so a
  // signed-out user can't be shown a cached protected page.
  window.addEventListener('storage', refresh);
  window.addEventListener('pageshow', refresh);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('pageshow', refresh);
    }
  };
}

function setSession(user: SessionUser | null): void {
  if (user) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  else window.localStorage.removeItem(STORAGE_KEY);
  cache = user;
  hasRead = true;
  listeners.forEach((l) => l());
}

// --- React context ------------------------------------------------------

interface SessionContextValue {
  user: SessionValue;
  signIn: (email: string, password: string) => Promise<SessionUser>;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | undefined>(
  undefined,
);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const user = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const signIn = useCallback(async (email: string, password: string) => {
    const signedIn = await apiSignIn(email, password);
    setSession(signedIn);
    return signedIn;
  }, []);

  const signOut = useCallback(() => {
    setSession(null);
  }, []);

  return (
    <SessionContext.Provider value={{ user, signIn, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}
