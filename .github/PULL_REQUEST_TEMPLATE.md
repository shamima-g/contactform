# Pull Request

## Summary

<!-- Brief description of what this PR does -->

## Changes

<!-- List the key changes made in this PR -->

-

## Testing

<!-- Describe how you tested these changes -->

-

## Quality Gate Checklist

> **Required for PR Approval**: All quality gates must pass before this PR can be merged. See [Quality Gates documentation](.template-docs/users/Help/Quality-Gates.md) for details.

### Gate 1: Functional (0% automated)

- [ ] Manual UX validation completed (for feature PRs)
- [ ] User workflows tested end-to-end
- [ ] Edge cases verified

### Gate 2: Security (80% automated)

- [ ] npm audit passes - no high/critical vulnerabilities (automated)
- [ ] TruffleHog scan passes - no secrets detected (automated)
- [ ] security-validator.js passes (automated)
- [ ] **Authentication**: Tested protected routes without authentication token (should return 401)
- [ ] **Authorization**: Tested role-based access (lower privilege user cannot access higher privilege functions)
- [ ] **XSS Prevention**: Tested form inputs with `<script>alert('xss')</script>` - input is properly escaped/rejected
- [ ] **File Upload** (if applicable): Tested file upload with malicious file types - uploads are properly validated
- [ ] **API Authorization**: Verified authorization checks on all modified API endpoints
- [ ] POPIA compliance reviewed (for PRs handling personal data)

### Gate 3: Code Quality (100% automated)

- [ ] TypeScript compilation passes (`npx tsc --noEmit`)
- [ ] ESLint passes (`npm run lint`)
- [ ] Prettier formatting verified (`npm run format:check`)
- [ ] Production build succeeds (`npm run build`)

### Gate 4: Testing (100% automated)

- [ ] All Vitest tests pass (`npm test`)
- [ ] Tests run on Node 20 and Node 22 (CI)
- [ ] Coverage requirements met

---

## Manual Review Notes

<!-- Complete applicable sections based on the type of changes in this PR -->

### Gate 1: UX/Functional Review Notes

<!-- For feature PRs: Document UX validation findings, tested workflows, edge cases verified -->
<!-- Skip this section for non-feature PRs (documentation, refactoring, etc.) -->

N/A or:
-

### Gate 2: POPIA Compliance Notes

<!-- For PRs handling personal data: Document PII fields affected, consent mechanisms, data handling -->
<!-- Skip this section if PR does not handle personal/sensitive data -->

N/A or:
-

---

## Related Issues

<!-- Link any related issues: Fixes #123, Relates to #456 -->

