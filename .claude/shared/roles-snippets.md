# Roles Template Snippets

Inline snippets consumed by `intake-agent` when emitting §Roles & Permissions in `project.md`. The user picks a template at INTAKE; the matching snippet below is inserted verbatim into project.md. Roles live in project.md from the INTAKE approval onward, and the user can edit any cell in the matrix before approving.

## Template Registry

| ID | Display name | Roles (most → least privileged) | Typical fit |
|---|---|---|---|
| `saas-standard` | SaaS Standard | Owner → Admin → Member → Viewer | Multi-tenant SaaS apps where billing/ownership is distinct from administrative access |
| `internal-tool` | Internal Tool | Admin → User | Back-office tools, internal dashboards, anything that doesn't need a viewer tier |
| `marketplace` | Marketplace | Moderator → Seller → Buyer | Two-sided platforms — separate roles for supply, demand, and oversight |
| `editorial` | Editorial | Editor → Author → Contributor → Reader | Content management, publishing, document workflows |
| `custom` | Custom (free-text) | — | None of the above; user provides role names inline via AUQ's auto-"Other" free-text affordance |

### Inference (Mode 1 — existing docs)

When `documentation/` mentions specific role names, `intake-agent` maps them to a template and pre-ticks that option:

- `admin` + `user` → `internal-tool`
- `owner` + `admin` + `member` + `viewer` → `saas-standard`
- `broker` + `viewer` + `admin` → `saas-standard` (closest fit; user can rename "Member" → "Broker" at the INTAKE approval)
- `buyer` + `seller` + `moderator` → `marketplace`
- `editor` + `author` + `reader` → `editorial`
- Anything else → `custom`

### Selection (at INTAKE)

`AskUserQuestion` presents the **four explicit templates** (SaaS Standard / Internal Tool / Marketplace / Editorial). The `custom` template is reached via AUQ's automatic "Other" free-text affordance — do **not** list "Custom" as an explicit option (the AUQ tool description forbids it).

When the user picks one of the four explicit templates, the orchestrator silently accepts the canonical role list — no drilldown. A one-line acknowledgement: _"Captured: <roles list>. You can refine these in `project.md` at the INTAKE approval."_

For `custom`, the free-text role list arrives in the same AUQ response. Capture as the custom role list inline in `project.md` §Roles & Permissions (no separate manifest file).

The selection drives which snippet below is embedded inline in `project.md` §Roles & Permissions.

Conventions:
- `✓` — permission granted
- (blank) — permission denied
- `~` — conditional grant (the brief carries the condition as a footnote)

---

## `saas-standard`

| Permission | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| View main dashboard | ✓ | ✓ | ✓ | ✓ |
| View shared content | ✓ | ✓ | ✓ | ✓ |
| Create content | ✓ | ✓ | ✓ | |
| Edit own content | ✓ | ✓ | ✓ | |
| Edit any content | ✓ | ✓ | | |
| Delete content | ✓ | ✓ | | |
| Invite members | ✓ | ✓ | | |
| Remove members | ✓ | ✓ | | |
| Change member roles | ✓ | ✓ | | |
| View billing | ✓ | | | |
| Manage billing / subscription | ✓ | | | |
| Transfer ownership | ✓ | | | |
| Manage organisation settings | ✓ | ✓ | | |
| Delete organisation | ✓ | | | |

---

## `internal-tool`

| Permission | Admin | User |
|---|---|---|
| View main dashboard | ✓ | ✓ |
| View own records | ✓ | ✓ |
| Create records | ✓ | ✓ |
| Edit own records | ✓ | ✓ |
| Edit any record | ✓ | |
| Delete records | ✓ | |
| Manage users | ✓ | |
| View audit log | ✓ | |
| Manage system settings | ✓ | |

---

## `marketplace`

| Permission | Moderator | Seller | Buyer |
|---|---|---|---|
| Browse listings | ✓ | ✓ | ✓ |
| View listing detail | ✓ | ✓ | ✓ |
| Create listing | | ✓ | |
| Edit own listing | | ✓ | |
| Place order | | | ✓ |
| Cancel own order | | | ✓ |
| Fulfil order (own listings) | | ✓ | |
| Message buyer / seller (own transactions) | ✓ | ✓ | ✓ |
| Report a listing or user | ✓ | ✓ | ✓ |
| Resolve a report | ✓ | | |
| Suspend a listing | ✓ | | |
| Suspend a user | ✓ | | |
| Refund an order | ✓ | ~ | |

> Footnote on `~` (Seller — Refund): conditional — sellers can refund their own buyers; moderators can refund any. Surface this condition in the brief for user confirmation.

---

## `editorial`

| Permission | Editor | Author | Contributor | Reader |
|---|---|---|---|---|
| View published content | ✓ | ✓ | ✓ | ✓ |
| View drafts (own) | ✓ | ✓ | ✓ | |
| View drafts (any) | ✓ | | | |
| Create draft | ✓ | ✓ | ✓ | |
| Edit own draft | ✓ | ✓ | ✓ | |
| Edit any draft | ✓ | | | |
| Submit for review | ✓ | ✓ | ✓ | |
| Approve / publish | ✓ | | | |
| Unpublish | ✓ | | | |
| Delete content | ✓ | | | |
| Manage taxonomies / tags | ✓ | | | |
| Manage contributors | ✓ | | | |

---

## `custom`

No default matrix. For `custom`, `intake-agent` emits a minimal table with the user-supplied role names from `context.customRoles` as columns and a single "View main dashboard" row marked granted for every role. The user expands the matrix at the INTAKE approval or during BUILD as stories surface specific permissions.
