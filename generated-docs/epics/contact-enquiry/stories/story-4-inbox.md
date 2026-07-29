# Story 4 — Back-office inbox

**Slug:** `story-4-inbox`
**Route:** `/inbox`
**Target file:** `web/src/app/inbox/page.tsx`
**Page action:** create_new
**Roles:** Support Agent, Admin
**Requirement IDs:** R8, R9, R13
**isInfrastructureOnly:** false

## Plain summary

As a Support Agent or Admin, see every enquiry from every visitor in one inbox. Filter it by category and status, sort it, and page through it when the list is long.

## Summary

The back-office inbox: a table of all enquiries (unscoped) with the submitter, category, status, and submitted date. Provides filter-by-category, filter-by-status, column sorting, and pagination against the API layer. Visitors are gated with a permission-denied banner.

## Acceptance Criteria

- AC-1: The inbox lists all enquiries from all visitors with the columns specified in the brief (submitter, category, status, submitted date). `coverage: playwright`
- AC-2: Filtering by a status and/or category narrows the list to matching enquiries; clearing restores the full list. `coverage: playwright`
- AC-3: Sorting by a column reorders the list, and paging moves through the results. `coverage: playwright`
- AC-4: A Visitor who opens `/inbox` sees a permission-denied banner instead of the inbox. `coverage: playwright`
- AC-5: When no enquiries match the active filters, an empty-state row/message is shown. `coverage: vitest`

## Manual test checklist

- Sign in as an Agent → you land on the inbox and see enquiries from multiple visitors.
- Filter by status "New" → only New enquiries remain; clear the filter → all return.
- Filter by category "Question" → only Questions remain.
- Sort by submitted date → the order changes.
- Page forward/back if there are enough rows → you move through the list.

**Additional technical checks:** 0
