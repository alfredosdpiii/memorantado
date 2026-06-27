# Dependency Policy

Dependency updates should be automated through Dependabot or Renovate.

## Minimum Release Age

New dependency versions should wait at least 3 days before adoption. Renovate is
configured with `minimumReleaseAge` to reduce exposure to compromised releases.

## Review Checklist

- Review release notes for breaking changes.
- Prefer patch and minor updates unless a major update is required.
- Run `npm run validate` before merging.
