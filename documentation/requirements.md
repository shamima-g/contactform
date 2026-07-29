# Contact & Enquiry Management — Authoritative Requirements

## Pitch

A Contact & Enquiry Management app. A **Visitor** submits a contact enquiry (name,
email, optional address, a category — Feedback / Question / General Enquiry — and a
comment) and gets an immediate confirmation with the form cleared. A **Support Agent**
works incoming enquiries from an inbox, moving each through New / In Progress / Resolved
(a resolve requires a reply note). An **Admin** can additionally delete enquiries.
Enquiries are role-scoped: a Visitor sees only their own.

## Roles

| Role | Can | Cannot |
| --- | --- | --- |
| **Visitor** | submit an enquiry; view their own submissions; sign in | see the inbox; see other people's enquiries; change status; delete |
| **Support Agent** | view all enquiries; search/filter; change status (New → In Progress → Resolved); resolve with a reply note | submit on the public form; delete |
| **Admin** | everything a Support Agent can; delete an enquiry | submit on the public form |

## Sign-in

- **Choice:** your own server (BFF).
- **Rationale:** The app is role-gated (Visitor vs Support Agent vs Admin) with
  role-based landing, RBAC action-hiding, and a permission-denied banner on direct
  links — so it needs authenticated roles to exercise. BFF matches the template's auth
  policy; the auth itself is **simulated client-side** per the prototype invariants
  (no real backend).

## Data source

- **No backend service.** Build against **in-memory fixtures** derived from the
  requirements: a handful of seeded enquiries across the three categories and statuses,
  plus the seeded users below. All server behaviour is simulated client-side.
- **Seeded users:**
  - `visitor@example.com` / `Test123` — Visitor
  - `agent@example.com` / `Test123` — Support Agent
  - `admin@example.com` / `Test123` — Admin

## Compliance

- **Regulated data:** No.
- **Note:** Collects personal data (name, email, optional address). Not a regulated
  domain, but enquiries must be visible only to authenticated back-office roles, never
  to other Visitors.

## Styling

- **Source:** none (no bespoke design system).
- **Note:** Use the template's Shadcn defaults with a clean, neutral palette and
  centralised styling tokens.

## Enquiry model

- **Fields captured on the public form:** Name, Email, Address (optional),
  Category (Feedback / Question / General Enquiry), Comment.
- **Status lifecycle:** `New → In Progress → Resolved`. Resolved is terminal — status
  actions hide once resolved. Resolving requires a **non-empty reply note**.
- **Scoping:** a Visitor sees only their own submissions (read-only). Back-office roles
  (Agent, Admin) see all enquiries.

## Behavioural acceptance checks (role-observable)

1. A Visitor can submit an enquiry and sees "Message sent!" with the form cleared.
2. A Support Agent sees the new enquiry in the inbox and can move it New → In Progress.
3. Resolving an enquiry requires a non-empty reply note.
4. A Visitor cannot reach the inbox — a direct link shows a permission-denied banner.
5. An Admin can delete an enquiry behind a confirmation; the Agent has no Delete action.

## Back-office inbox

- Sortable / filterable / paginated list of all enquiries for Agent and Admin.
- Search/filter (by category and/or status).
- Status transitions surfaced as actions that respect the lifecycle (no action once
  Resolved).
