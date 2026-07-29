# Story 5 — Triage: status lifecycle

**Slug:** `story-5-triage-status`
**Route:** `/inbox`
**Target file:** `web/src/app/inbox/page.tsx`
**Page action:** modify_existing
**Roles:** Support Agent, Admin
**Requirement IDs:** R10, R11
**isInfrastructureOnly:** false

## Plain summary

As a Support Agent or Admin, move an enquiry through its lifecycle — New → In Progress → Resolved. Resolving it requires you to enter a reply note; once resolved, no further status actions are offered.

## Summary

Adds status transitions to the inbox rows/detail: a "Start progress" action (New → In Progress) and a "Resolve" action that opens a dialog requiring a non-empty reply note (In Progress → Resolved). Transitions follow the lifecycle order and Resolved is terminal — status actions disappear once resolved. Persists via the API layer.

## Acceptance Criteria

- AC-1: A New enquiry offers a "Start progress" action that moves it to In Progress. `coverage: playwright`
- AC-2: Resolving opens a reply-note prompt; submitting with an empty note is rejected with a validation message and the enquiry stays In Progress. `coverage: playwright`
- AC-3: Resolving with a non-empty note moves the enquiry to Resolved and stores the note. `coverage: playwright`
- AC-4: A Resolved enquiry offers no further status actions. `coverage: vitest`

## Manual test checklist

- On a New enquiry, click "Start progress" → its status becomes In Progress.
- Click "Resolve" and leave the note empty → you see a message and it is not resolved.
- Enter a reply note and confirm → the enquiry becomes Resolved.
- On a Resolved enquiry → there are no more status buttons.

**Additional technical checks:** 0
