# Story 3 — My submissions

**Slug:** `story-3-my-submissions`
**Route:** `/my-submissions`
**Target file:** `web/src/app/my-submissions/page.tsx`
**Page action:** create_new
**Roles:** Visitor
**Requirement IDs:** R7, R13
**isInfrastructureOnly:** false

## Plain summary

As a Visitor, see a read-only list of the enquiries you have submitted — and only yours — each with its current status. If you haven't submitted anything yet, you see a friendly empty state.

## Acceptance Criteria

- AC-1: The list shows the signed-in Visitor's own enquiries with their category, comment, and current status. `coverage: vitest`
- AC-2: The list never shows another visitor's enquiry. `coverage: vitest`
- AC-3: When the Visitor has no submissions, an empty-state message is shown instead of an empty table. `coverage: vitest`
- AC-4: A Support Agent or Admin who opens `/my-submissions` sees a permission-denied banner. `coverage: playwright`

## Manual test checklist

- As a Visitor, open "My submissions" → you see only enquiries you submitted, with statuses.
- Submit a new enquiry, then return to "My submissions" → the new one appears.
- Sign in as a different visitor with no submissions → you see the empty-state message.

**Additional technical checks:** 0
