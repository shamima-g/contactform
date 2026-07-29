# Story 2 — Submit an enquiry

**Slug:** `story-2-submit-enquiry`
**Route:** `/contact`
**Target file:** `web/src/app/contact/page.tsx`
**Page action:** create_new
**Roles:** Visitor
**Requirement IDs:** R5, R6, R13
**isInfrastructureOnly:** false

## Plain summary

As a Visitor, fill in the contact form — your name, email, an optional address, a category (Feedback / Question / General Enquiry) and a comment — and send it. You immediately see a confirmation of exactly what you sent with a "Message sent!" message, and the form is cleared for a next enquiry.

## Summary

The public contact form for the Visitor role. Renders the five fields with inline validation (required fields + email format), submits through the API layer to create a `New` enquiry owned by the signed-in Visitor, then shows a confirmation of the submitted details with "Message sent!" and resets the form. Non-Visitor roles are gated with a permission-denied banner.

## Acceptance Criteria

- AC-1: The form renders the fields specified in the brief — name, email, optional address, category (Feedback / Question / General Enquiry), and comment. `coverage: vitest`
- AC-2: Submitting with a required field empty or an invalid email shows an inline validation message and does not send. `coverage: vitest`
- AC-3: A successful submit shows "Message sent!" and a confirmation of what was sent, and clears the form. `coverage: vitest`
- AC-4: A Support Agent or Admin who opens `/contact` sees a permission-denied banner instead of the form. `coverage: playwright`

## Manual test checklist

- As a Visitor, submit the form with all fields → you see "Message sent!" and a summary of what you sent.
- After submitting, the form is empty again.
- Try to submit with the email left blank → you see a validation message and nothing sends.
- Sign in as an Agent and open `/contact` in the address bar → you see a "you don't have permission" message.

**Additional technical checks:** 1
