# memorantado Runbook

## Health

- Local health check: `GET http://127.0.0.1:3789/api/health`
- Local metrics: `GET http://127.0.0.1:3789/api/metrics`
- Server binds to `127.0.0.1` only and should not be exposed publicly.

## Common Recovery Steps

1. Run `npm run validate` to reproduce code, test, schema, and bundle checks.
2. If startup fails, verify Node.js `>=20` and run `npm ci && npm run build`.
3. If database state is suspect, stop the server and back up `MEMORANTADO_DB`.
4. Restore from the latest SQLite backup, or remove the local database to rebuild
   an empty schema on next startup.

## SQLite Backup

The default database is `~/.memorantado/memorantado.sqlite`. Back up the main
file and WAL/SHM sidecars while the server is stopped.

## Observability

Use request IDs from the `x-request-id` response header to correlate local logs
with API calls. The metrics endpoint exposes request counts and durations in
Prometheus text format.
