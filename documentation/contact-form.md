# Contact & Enquiry Management — brief

A contact form that feeds a role-gated back-office triage workflow. Three roles, so it
exercises the template's auth + RBAC surface (role-based landing, action-hiding,
permission-denied banner, role switcher, a role on every story).

> The authoritative BRD is [frontend/docs/requirements.md](frontend/docs/requirements.md);
> the Tier 3 driver answers are in [answers.json](answers.json). This file is just the pitch.

## What it does

- **Visitor** submits an enquiry — **Name, Email, Address (optional), Category** (Feedback /
  Question / General Enquiry), **Comment**. On save: land on a confirmation page showing what
  was sent, the form clears, and "Message sent!" appears. A Visitor can also review their own
  past submissions (read-only, own only).
- **Support Agent** works incoming enquiries from an **inbox** (sortable / filterable /
  paginated), and moves each through **New → In Progress → Resolved**. Resolving requires a
  **reply note**.
- **Admin** can do everything an Agent can, plus **delete** an enquiry (behind a confirmation).

## Roles at a glance

| Role | Lands on | Can | Cannot |
| ---- | -------- | --- | ------ |
| Visitor | Contact form | submit; view own submissions | see the inbox or others' enquiries; triage; delete |
| Support Agent | Inbox | read all; filter/sort; change status; resolve-with-note | submit on the public form; delete |
| Admin | Inbox | everything an Agent can + delete | submit on the public form |

## Status lifecycle

`New → In Progress → Resolved` (Resolved is terminal — status actions hide once resolved).

## Run it

```powershell
# from tier-3-automated/
./Run-QATests.ps1 -IncludeTier3 -Benchmark contact-form
```
