# Story 1 — Sign in & role-based landing

**Slug:** `story-1-sign-in-role-landing`
**Route:** `/` (sign-in when signed out; role-aware redirect when signed in)
**Target file:** `web/src/app/page.tsx` (+ shared shell, session, data layer)
**Page action:** modify_existing
**Roles:** Visitor, Support Agent, Admin
**Requirement IDs:** R1, R2, R3, R4, R13
**isInfrastructureOnly:** false
**epicIntroducesSharedSurface:** true

## Plain summary

Sign in with a seeded email and password and land on the right home screen for your role — a Visitor on the contact form, a Support Agent or Admin on the inbox. Signed-out visits to any page send you to sign-in, and opening a page your role can't use shows a clear "you don't have permission" message.

## Summary

Establishes the app shell: a client-side simulated session (`SessionProvider` + `useSession`), the in-memory data layer + seed (users + enquiries), the sign-in screen, role-based landing redirect, a route guard that renders a permission-denied banner for out-of-role routes, and a sign-out / role indicator in the shell.

## Acceptance Criteria

- AC-1: Signing in with a seeded email + password lands the user on their role's home (Visitor → contact form, Agent/Admin → inbox). `coverage: playwright`
- AC-2: Signing in with a wrong password shows an inline error and stays on the sign-in screen. `coverage: vitest`
- AC-3: While signed out, any protected URL — including the app root — shows the sign-in screen, not app content. `coverage: playwright`
- AC-4: After signing out, pressing the browser Back button does not reveal the previous protected page — the user is returned to sign-in. `coverage: playwright`
- AC-5: A signed-in user who opens a route their role can't access sees an on-page permission-denied banner (not an error page, not the content). `coverage: playwright`
- AC-6: The signed-in shell shows who you are and a Sign out control that returns you to sign-in. `coverage: vitest`

## Manual test checklist

- Open the app while signed out → you land on the sign-in page, not a welcome page.
- Sign in as `visitor@example.com` / `Test123` → you land on the contact form.
- Sign in as `agent@example.com` / `Test123` → you land on the inbox.
- Sign in as `admin@example.com` / `Test123` → you land on the inbox.
- Enter a wrong password → you see an error and stay on sign-in.
- Sign in, sign out, then press the browser Back button → you're sent to sign-in, not back into the app.

**Additional technical checks:** 1
