# Epic Plan — Contact & Enquiry Management

Every epic in this project, what it delivers, and what it builds on. Live status
(not started / in flight / done) is shown by `/status` and the dashboard.

> Plan only — edited during planning on `main`, never on an epic branch.

## Epics

| # | Epic | Delivers | Builds on |
|---|---|---|---|
| 1 | Contact & Enquiry Management (`contact-enquiry`) | The whole app: sign-in with role-based landing and permission-denied gating; a Visitor contact form with confirmation and an own-submissions view; a back-office inbox for Agents/Admins with filter/sort/pagination and the New → In Progress → Resolved lifecycle (resolve-with-note); and Admin-only delete. | — |

_One cohesive vertical — a public contact form feeding a role-gated triage workflow. Kept as a single epic so it ships as one coherent app rather than a chain of interdependent partial merges._

## Coverage

Everything in the spec is assigned to an epic:

| What you asked for | Epic |
|---|---|
| Sign in as Visitor / Support Agent / Admin with seeded credentials (R1) | Contact & Enquiry Management (`contact-enquiry`) |
| Role-based landing — Visitor → contact form, Agent/Admin → inbox (R2) | Contact & Enquiry Management (`contact-enquiry`) |
| Permission-denied banner on a direct link to a route you can't access (R3) | Contact & Enquiry Management (`contact-enquiry`) |
| Switch role / re-login to exercise all three roles (R4) | Contact & Enquiry Management (`contact-enquiry`) |
| Visitor submits an enquiry — name, email, optional address, category, comment (R5) | Contact & Enquiry Management (`contact-enquiry`) |
| On submit: confirmation of what was sent, form clears, "Message sent!" (R6) | Contact & Enquiry Management (`contact-enquiry`) |
| Visitor views their own submissions, read-only, own only (R7) | Contact & Enquiry Management (`contact-enquiry`) |
| Agent/Admin see the inbox of all enquiries (R8) | Contact & Enquiry Management (`contact-enquiry`) |
| Inbox is sortable / filterable / paginated (R9) | Contact & Enquiry Management (`contact-enquiry`) |
| Change status New → In Progress → Resolved, lifecycle-respecting (R10) | Contact & Enquiry Management (`contact-enquiry`) |
| Resolving requires a non-empty reply note (R11) | Contact & Enquiry Management (`contact-enquiry`) |
| Admin can delete an enquiry behind a confirmation; Agent has no Delete (R12) | Contact & Enquiry Management (`contact-enquiry`) |
| Enquiries visible only to back-office roles; Visitor never sees others' (R13) | Contact & Enquiry Management (`contact-enquiry`) |

_13 requirements, all assigned._
