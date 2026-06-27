# Data Handling

memorantado stores user-provided memory content locally in SQLite. Memory items,
entity names, observations, tags, and sources can contain personal or sensitive
information.

## PII Guidelines

- Do not commit local SQLite databases or exported memory data.
- Keep `.env` files and database paths out of version control.
- Avoid storing secrets, credentials, access tokens, or private keys as memory.
- When sharing bug reports, redact names, emails, tokens, and private project
  details from memory content and logs.

## Retention and Deletion

- Memory items can be deleted with `DELETE /api/memory-items/:id`.
- Observations and relations can be deleted through the REST API or MCP tools.
- Removing the SQLite database deletes all local memory for that database path.

## Logging

Runtime logging redacts sensitive request headers such as `authorization`,
`cookie`, `set-cookie`, and `x-api-key`.
