# Contact & Enquiry Management

A contact form that feeds a role-gated back-office triage workflow. Visitors submit enquiries; Support Agents work them from an inbox through a status lifecycle; Admins can additionally delete. Enquiries carry personal data and are visible only to authenticated back-office roles — a Visitor sees only their own.

| Field | Value |
|---|---|
| Project slug | `contact-enquiry-management` |
| Created | 2026-07-29 |
| Intake source | docs |
| Backend connectivity | mock-only |

---

## Roles & Permissions

**Template:** `custom`

Three roles: **Visitor** (public submitter), **Support Agent** (back-office triage), **Admin** (triage + delete). Back-office roles do not use the public submit form.

| Permission | Visitor | Support Agent | Admin |
|---|---|---|---|
| Sign in | ✓ | ✓ | ✓ |
| Submit an enquiry (public form) | ✓ | | |
| View own submissions | ✓ | | |
| View all enquiries (inbox) | | ✓ | ✓ |
| Search / filter / sort / paginate the inbox | | ✓ | ✓ |
| Change status (New → In Progress → Resolved) | | ✓ | ✓ |
| Resolve with a reply note | | ✓ | ✓ |
| Delete an enquiry | | | ✓ |

> Permissions extend during BUILD as new stories surface new actions — see [agent-autonomy.md](.claude/shared/agent-autonomy.md). Additions land here via a project-change PR (§6.1 of the epic-branch plan). Permission removals or role-set changes halt for user review.

---

## Authentication

| Field | Value |
|---|---|
| Method | `bff` |
| BFF login endpoint (if BFF) | simulated client-side (no real backend) |
| BFF userinfo endpoint (if BFF) | simulated client-side (no real backend) |
| BFF logout endpoint (if BFF) | simulated client-side (no real backend) |
| Custom auth notes (if custom) | Auth follows the BFF **shape/policy** (cookie-session mental model, role-based landing, RBAC action-hiding, permission-denied banner on direct links) but is **simulated client-side** per the prototype invariants — there is no real backend. Three seeded users: `visitor@example.com` / `Test123` (Visitor), `agent@example.com` / `Test123` (Support Agent), `admin@example.com` / `Test123` (Admin). A role switcher / re-login exercises all three roles. |

> Auth method is never inferred — the user confirmed BFF explicitly per [authentication-intake.md](.claude/policies/authentication-intake.md).

---

## Data Source & Backend Integration

| Field | Value |
|---|---|
| Data source | `mock-only` |
| Backend status | `N/A` |
| Mock layer required | yes |

No backend service. All server behaviour is simulated client-side against in-memory fixtures derived from the requirements: a handful of seeded enquiries spanning all three categories (Feedback / Question / General Enquiry) and all three statuses (New / In Progress / Resolved), plus the three seeded users above. Enquiries persist for the session only.

---

## Compliance

**Applicable domains:** None
**Region (if Personal data applies):** not specified

### Compliance Requirements

The app is **not** a regulated domain. It does, however, collect personal data (name, email, optional address). The single binding obligation carried forward:

- **Access scoping:** Enquiries (which contain personal data) MUST be visible only to authenticated back-office roles (Support Agent, Admin). A Visitor MUST NOT see the inbox or any enquiry other than their own — enforced by role-based routing, RBAC action-hiding, and a permission-denied banner on direct links.

---

## Styling & Branding

| Field | Value |
|---|---|
| Primary brand color | `#18181B` <!-- Shadcn neutral (zinc-900) default --> |
| Accent / secondary | `#71717A` <!-- zinc-500 --> |
| Background (light) | `#FFFFFF` |
| Background (dark, if applicable) | `#09090B` <!-- zinc-950 --> |
| Font family (headings) | system / geist (template default) |
| Font family (body) | system / geist (template default) |
| Theme | both |
| Source | defaulted (no bespoke design system — Shadcn neutral defaults) |

> No bespoke design system. Use the template's Shadcn defaults with a clean, neutral palette and centralised styling tokens in `globals.css`; no hex literals in components, per [styling-centralisation.md](.claude/policies/styling-centralisation.md).

---

## Baseline NFRs

- **NFR-base-1:** Accessibility — WCAG 2.1 Level AA baseline
- **NFR-base-2:** Performance — First Contentful Paint < 2.5s on a mid-tier mobile network
- **NFR-base-3:** Responsive design — mobile (≥360px) / tablet (≥768px) / desktop (≥1280px) breakpoints
- **NFR-base-4:** Browser support — latest two versions of Chrome / Edge / Firefox / Safari
- **NFR-base-5:** Error UX — user-visible error states with retry affordance for all async operations
