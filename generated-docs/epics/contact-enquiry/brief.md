# Epic Brief — Contact & Enquiry Management (`contact-enquiry`)

Inherits roles, auth, data source, compliance, and styling from project.md.

## Goal

Deliver the whole Contact & Enquiry Management experience: a public contact form a Visitor uses to submit an enquiry and see it confirmed, a private view of their own past submissions, and a role-gated back-office where Support Agents and Admins triage every enquiry through a status lifecycle — with Admin-only delete. Sign-in with three seeded roles drives role-based landing, action-hiding, and a permission-denied banner on out-of-role links.

## Data Model

**Enquiry**

| Field | Type | Notes |
|---|---|---|
| `id` | string | System-generated (e.g. `enq_001`). |
| `name` | string | Required. Submitter's name. |
| `email` | string | Required. Valid email format. |
| `address` | string \| null | Optional. |
| `category` | enum | One of `Feedback` \| `Question` \| `General Enquiry`. Required. |
| `comment` | string | Required. Free text. |
| `status` | enum | `New` \| `In Progress` \| `Resolved`. Defaults to `New`. |
| `replyNote` | string \| null | Set when resolved; required to move to `Resolved`. |
| `submittedByEmail` | string | Email of the Visitor who submitted (owner, for scoping). |
| `createdAt` | ISO string | Submission timestamp. |
| `updatedAt` | ISO string | Last status/edit timestamp. |

**User** (seeded, mock)

| Field | Type | Notes |
|---|---|---|
| `email` | string | Login identity. |
| `password` | string | Mock only — `Test123` for all seeded users. |
| `role` | enum | `Visitor` \| `Support Agent` \| `Admin`. |
| `name` | string | Display name. |

Seeded users: `visitor@example.com` (Visitor), `agent@example.com` (Support Agent), `admin@example.com` (Admin) — all password `Test123`. Seed a handful of enquiries spanning all three categories and all three statuses; at least two owned by `visitor@example.com` so the own-submissions view is non-empty.

## Functional Requirements

- **R1:** A user can sign in with a seeded email + password and is recognised as their role (Visitor, Support Agent, or Admin).
- **R2:** After sign-in the user lands on the screen for their role — a Visitor on the contact form, a Support Agent or Admin on the inbox.
- **R3:** A signed-in user who opens a URL their role can't access sees an on-page permission-denied banner (not an error page, not the content).
- **R4:** A user can sign out and sign in as a different seeded role, exercising all three roles in one session.
- **R5:** A Visitor can submit an enquiry providing name, email, optional address, a category (Feedback / Question / General Enquiry), and a comment.
- **R6:** On a successful submit the Visitor sees a confirmation of what was sent, a "Message sent!" message, and the form is cleared.
- **R7:** A Visitor can view a read-only list of their own past submissions and no one else's.
- **R8:** A Support Agent or Admin sees an inbox listing all enquiries from all visitors.
- **R9:** The inbox can be filtered (by category and/or status), sorted, and paginated.
- **R10:** A Support Agent or Admin can move an enquiry through New → In Progress → Resolved; once Resolved no further status actions are offered.
- **R11:** Moving an enquiry to Resolved requires a non-empty reply note; an empty note is rejected.
- **R12:** An Admin can delete an enquiry after confirming; a Support Agent is never shown a Delete action.
- **R13:** Enquiries are visible only to authenticated back-office roles and their own submitter — a Visitor never sees the inbox or another visitor's enquiry.

## Business Rules

- **BR1:** Status transitions follow the lifecycle order New → In Progress → Resolved. Resolved is terminal — no transition out of Resolved.
- **BR2:** A resolve action is rejected unless a reply note with non-whitespace content is provided; the note is stored on the enquiry.
- **BR3:** New enquiries are created with status `New` and `submittedByEmail` equal to the signed-in Visitor.
- **BR4:** Delete is Admin-only and irreversible; it is gated behind an explicit confirmation.
- **BR5:** The public submit form is available only to the Visitor role; Support Agents and Admins do not submit.
- **BR6:** Visitor enquiry scoping filters on `submittedByEmail === session.email`; back-office roles see the unfiltered set.

## Key Workflows

1. **Sign in → land by role.** User signs in → session established → redirected to their role's home (Visitor: contact form; Agent/Admin: inbox).
2. **Submit an enquiry.** Visitor fills the form → validation passes → enquiry created as `New` → confirmation screen shows the submitted details + "Message sent!" → form cleared for a next submission.
3. **Review own submissions.** Visitor opens "My submissions" → sees only their own enquiries with current status, read-only.
4. **Triage from the inbox.** Agent/Admin opens the inbox → filters/sorts/paginates → opens an enquiry → moves New → In Progress → clicks Resolve → must enter a reply note → enquiry becomes Resolved and status actions disappear.
5. **Admin delete.** Admin opens an enquiry (or its inbox row) → clicks Delete → confirms → enquiry removed from the inbox.
6. **Blocked access.** A Visitor types the inbox URL → sees a permission-denied banner instead of the inbox.

## Feature NFRs

- **NFR-1:** Mock persistence lasts the browser session; a reload keeps in-session changes only as far as the mock store is designed to (session-scoped acceptable for a prototype).
- **NFR-2:** All three roles are reachable through a visible sign-out / role-switch affordance so a tester can exercise every role without dev tools.
- **NFR-3:** Form validation is inline and user-visible (required fields, email format) before submit is accepted.

## Out of Scope

- Real backend, real authentication, real email delivery — all simulated client-side.
- Editing an enquiry's content after submission (only status + reply note change).
- Visitor account self-registration — users are seeded.
- Cross-session persistence beyond what the in-memory/session mock provides.

## Notes & Caveats

- **Auth is simulated client-side** per the prototype invariants — the BFF shape (cookie-session mental model, role-based landing, RBAC action-hiding, permission-denied banner) is honoured in the UX, but there is no real server. Do NOT carry a real OIDC/login backend into production expectations from this build.
- Personal data (name, email, optional address) sits in enquiries — the access-scoping rule (BR6 / R13) is the one binding obligation: never leak an enquiry to a non-owner Visitor.
