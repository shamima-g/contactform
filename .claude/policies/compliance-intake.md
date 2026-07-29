# Compliance & Regulatory Intake Policy

## Core Principle

Compliance requirements fundamentally shape application architecture — they cannot be bolted on later. **Never skip compliance during INTAKE.** Features that handle sensitive data (payments, personal information, health records) must have their regulatory obligations surfaced early, even when the user hasn't mentioned them.

The **multi-select confirmation of which domains apply is a blocking question**; the **domain-specific implementation details** then flow into `project.md` §Compliance as `[INFERRED]` entries the user reviews at the INTAKE approval.

---

## Mandatory Rules

1. **Always ask the compliance multi-select question** during INTAKE. The applicable domains must be established before `project.md` is generated, because compliance-shaped requirements (in §Compliance) are derived from this answer.

2. **Never assume compliance is not applicable.** If the user picks "none," confirm explicitly: "Just to confirm — the app won't handle payment card data, personal information (names, emails, addresses), health records, or data subject to industry regulations?" An affirmative answer is recorded; a hesitation re-opens the multi-select.

3. **Never carry prototype compliance shortcuts into production.** Prototypes routinely include payment forms, user registration screens, and data collection flows without any compliance considerations. These are acceptable in a demo but must be flagged during INTAKE for the production spec.

4. **Surface compliance implications proactively.** Use `inferredAnswers.complianceDomainsDetected` from `intake-agent` Call A (which has already run keyword detection over `documentation/` and the project description) to pre-tick domains in the multi-select. Re-scan only when Call A did not return the field (e.g., manual reruns). The user is correcting a draft, not building from a blank list.

5. **Implementation details fold to `project.md` §Compliance.** Once the applicable domains are established, the agent generates `[INFERRED]` entries describing how those domains typically constrain the app (third-party payment fields, right-to-erasure, audit log, tenant isolation, etc.). These entries are derived from industry-standard practice for the domain — not from a vacuum. The user reviews them at the INTAKE approval and edits any that don't fit their context.

---

## Keyword Triggers

When any of the following appear in documentation, project descriptions, or user answers, the orchestrator must pre-tick the corresponding compliance domain in the multi-select:

| Keywords | Compliance Domain | Manifest ID | Key Concern |
|----------|------------------|-------------|-------------|
| payment, checkout, billing, invoice, card, credit card, debit card, subscription, pricing, charge | **PCI-DSS** | `pci-dss` | Never store card numbers or CVVs; use tokenisation via certified payment provider (Stripe, Adyen, etc.); no card data in logs |
| user profile, registration, sign-up, email, phone, address, name, date of birth, personal data | **Data Protection (GDPR / POPIA / CCPA)** | `gdpr`, `popia`, or `ccpa` | Consent management, data minimisation, right to erasure, privacy policy, cookie consent |
| patient, health, medical, diagnosis, prescription, clinical, vitals | **HIPAA** | `hipaa` | PHI handling, access controls, audit trails, encryption at rest and in transit |
| tenant, multi-tenant, SaaS, customer data, B2B | **SOC 2** | `soc2` | Data isolation, access controls, audit logging, incident response |
| location, GPS, tracking, geolocation | **Data Protection + ePrivacy** | `gdpr`, `popia`, or `ccpa` | Location data is sensitive personal data; requires explicit consent |
| file upload, document, attachment | **Data Protection** | `gdpr`, `popia`, or `ccpa` | File type validation, malware scanning, storage encryption, retention policies |
| audit, log, trail, history | **Multiple** | *(use the domain-specific ID)* | Immutable audit trails may be required by PCI-DSS, HIPAA, SOC 2, or industry-specific regulations |

---

## The Multi-Select Question

The INTAKE checklist Q5 is a single `AskUserQuestion` multi-select with regional data-protection variants collapsed under one "Personal data" option (keeps the option count ≤4 for `AskUserQuestion`):

> "Which of these compliance areas apply to this project? (Select all that apply.)"

| Option | Domain(s) captured | When to pre-tick |
|---|---|---|
| Payment / card data (PCI-DSS) | `pci-dss` | Any payment keyword triggered |
| Personal data (GDPR / POPIA / CCPA) | one of `gdpr`, `popia`, `ccpa` — resolved via the region follow-up | Any personal-data keyword triggered |
| Health / patient data (HIPAA) | `hipaa` | Health keywords triggered |
| Multi-tenant SaaS (SOC 2) | `soc2` | Tenant/B2B keywords triggered |

**Region follow-up (only when "Personal data" was selected):** a single-select `AskUserQuestion` with the options `EU/UK (GDPR)`, `South Africa (POPIA)`, `California (CCPA)`, `Multiple / not sure`. The chosen region maps to one of `gdpr`, `popia`, or `ccpa` in the final `complianceDomains` array. `Multiple / not sure` defaults to `gdpr` (most restrictive) with a note in `complianceNotes`.

**Region fold (prototype path only):** when `intake-agent` Call A produces `localeSignals` and ≥2 of the four signals (`currency`, `phone`, `locale`, `address`) agree on a region with no contradictions, the orchestrator **skips the Region follow-up** and records the region as `[INFERRED]` in `project.md` with a source breakdown. The user reviews and corrects at the INTAKE approval. See [`start.md`](../commands/start.md) Region fold check, and [`intake-agent.md`](../agents/intake-agent.md) § Locale Signal Detection.

**"None apply" path:** there is no explicit option — if the user selects nothing (or uses the AUQ "Other" path with "none"), the orchestrator runs Rule 2's confirmation: "Just to confirm — the app won't handle payment card data, personal information, health records, or data subject to industry regulations?" before accepting "none."

The orchestrator does NOT ask the per-domain follow-ups inline — they are folded into `project.md` §Compliance as described in the next section.

---

## Per-Domain `[INFERRED]` Entries

After the multi-select is captured, the agent populates `project.md` §Compliance with the following entries — **one block per selected domain**. Each entry is `[INFERRED]` because the agent is applying domain knowledge (industry-standard obligations for the domain), not falling back to defaults in the absence of source.

### PCI-DSS

```markdown
- `[INFERRED]` Payment handling: third-party hosted payment fields (Stripe / Adyen / PayFast pattern); no raw card data (PAN, CVV, magnetic stripe) on our servers
- `[INFERRED]` Payment-related errors MUST NOT include card numbers or sensitive payment details in error messages or logs
- `[INFERRED]` Payment pages served over HTTPS with TLS 1.2+
```

### Data Protection (GDPR / POPIA / CCPA)

```markdown
- `[INFERRED]` Personal data collection includes a clear purpose statement and user consent mechanism
- `[INFERRED]` Right to erasure: users can request deletion of their personal data via the Profile page
- `[INFERRED]` Personal data encrypted at rest and in transit
- `[INFERRED]` Privacy policy link visible on all data-collection forms
```

### HIPAA

```markdown
- `[INFERRED]` All access to PHI logged in an immutable audit trail
- `[INFERRED]` PHI never appears in error messages, logs, or client-side state
- `[INFERRED]` PHI encrypted at rest (AES-256) and in transit (TLS 1.2+)
- `[INFERRED]` Session timeouts enforced on screens displaying PHI
```

### SOC 2

```markdown
- `[INFERRED]` Tenant data isolated — no cross-tenant data access
- `[INFERRED]` All data access logged with user identity, action, and timestamp
```

### Accessibility (Always Applied — Industry Default)

Accessibility is not selected via the multi-select; it is always present in `project.md` §Baseline NFRs (`NFR-base-1`) because WCAG 2.1 AA is legally required in many jurisdictions (ADA in the US, EAA in the EU, PAIA in South Africa).

```markdown
- `[DEFAULT]` Accessibility: WCAG 2.1 Level AA baseline
```

---

## CR Generation Inside the Brief

The `intake-agent` writes `[INFERRED]` compliance entries directly into `project.md` §Compliance as testable constraints, one bullet per obligation.

If the user **edits** a compliance entry during the INTAKE approval (e.g., strikes "tenant data isolated" because the app is single-tenant), only the surviving entries remain in §Compliance.

If no compliance domains apply, §Compliance reads: "No compliance domains were identified during intake screening."
