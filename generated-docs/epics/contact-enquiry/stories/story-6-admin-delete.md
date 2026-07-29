# Story 6 — Admin delete

**Slug:** `story-6-admin-delete`
**Route:** `/inbox`
**Target file:** `web/src/app/inbox/page.tsx`
**Page action:** modify_existing
**Roles:** Admin
**Requirement IDs:** R12
**isInfrastructureOnly:** false

## Plain summary

As an Admin, delete an enquiry from the inbox — after confirming, so it can't happen by accident. A Support Agent never sees a Delete option.

## Acceptance Criteria

- AC-1: An Admin sees a Delete action on each inbox enquiry. `coverage: playwright`
- AC-2: Clicking Delete opens a confirmation; confirming removes the enquiry from the inbox. `coverage: playwright`
- AC-3: Cancelling the confirmation leaves the enquiry in place. `coverage: vitest`
- AC-4: A Support Agent never sees a Delete action. `coverage: playwright`

## Manual test checklist

- Sign in as an Admin → each enquiry has a Delete option.
- Click Delete → you must confirm before anything happens.
- Confirm → the enquiry disappears from the inbox.
- Cancel → the enquiry stays.
- Sign in as an Agent → there is no Delete option anywhere.

**Additional technical checks:** 0
