# Alerts

memorantado is local-only, so production paging is not configured in this repo.
Repository automation still creates issues for failed CI runs through
`.github/workflows/error-insights.yml`.

## Alert Rules

- CI validation failure on `main`: open a high-priority GitHub issue.
- Security audit findings: upload the npm audit report and comment on PRs.
- DAST endpoint security failure: fail the `DAST` workflow.

## Triage

1. Open the failed workflow from the generated issue.
2. Reproduce locally with `npm run validate`.
3. Fix the failing check, then close the generated issue after CI passes.
