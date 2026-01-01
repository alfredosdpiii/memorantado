# AGENTS.md - memorantado

Guidelines for AI coding agents working in this repository.

## Build / Dev / Typecheck

```bash
npm run build        # Build web UI + TypeScript + copy schema to dist
npm run dev          # Build web, then watch/run server with tsx (hot reload)
npm run dev:web      # Vite dev server for web UI only (proxies API to :3789)
npm run typecheck    # TypeScript check without emit
npm run start        # Run compiled dist/main.js
```

**No test framework configured.** There are no tests in this project.

## Architecture

MCP (Model Context Protocol) server with persistent SQLite storage and Svelte web UI.

```
src/
  main.ts              # Fastify server entry, binds MCP + API + static
  security.ts          # Loopback-only + host/origin validation
  api/routes.ts        # REST API for web UI
  mcp/
    server.ts          # MCP tool definitions (Zod schemas)
    http.ts            # StreamableHTTPServerTransport session mgmt
    project.ts         # Project name resolution helper
    eventStore.ts      # In-memory SSE event store
  db/
    db.ts              # SQLite connection (better-sqlite3)
    migrate.ts         # Runs schema.sql on startup
    schema.sql         # DDL + FTS5 + triggers
    graph.ts           # Knowledge graph operations
    timeline.ts        # Memory timeline operations

web/                   # Svelte 5 frontend (separate tsconfig)
  src/
    App.svelte         # Router + project selector
    lib/api.ts         # fetch wrapper for /api/*
    routes/*.svelte    # Search, Graph, Entity, MemoryItems
```

**Two-layer data model:**
1. Knowledge Graph: entities + observations + relations (FTS5 search)
2. Memory Timeline: append-only items with kind/title/content/tags

## TypeScript Configuration

- **Target**: ES2022
- **Module**: NodeNext (requires `.js` extensions in relative imports)
- **Strict mode**: Enabled (noImplicitAny, strictNullChecks, etc.)
- Web UI uses separate tsconfig extending `@tsconfig/svelte`

## Code Style

### Imports

```typescript
// Type-only imports use `import type`
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

// Relative imports MUST include .js extension (NodeNext resolution)
import { openDb } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import * as graph from "../db/graph.js";

// Node built-ins use node: prefix
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
```

### Type Definitions

```typescript
// Prefer explicit type aliases for domain objects
export type GraphEntity = {
  name: string;
  entityType: string;
  observations: string[];
};

// Use inline type assertions for DB rows
const row = stmt.get(project, name) as { id: number; name: string } | undefined;

// Options objects use inline types
opts: { kind?: string; limit?: number; offset?: number } = {}
```

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Types | PascalCase | `GraphEntity`, `MemoryItem` |
| Functions | camelCase | `createEntities`, `searchNodes` |
| Variables | camelCase | `seedIds`, `obsRows` |
| Constants | UPPER_SNAKE | `MAX_SEED_ENTITIES`, `PORT` |
| DB columns | snake_case | `entity_type`, `created_at` |
| Files | kebab-case or camelCase | `routes.ts`, `eventStore.ts` |

### Fastify Routes

```typescript
// Use generics for typed request parameters
app.get<{
  Params: { name: string };
  Querystring: { project?: string };
}>("/api/entity/:name", async (req, reply) => {
  const project = resolveProject(req.query.project);
  const entity = graph.getEntityByName(db, project, req.params.name);

  if (!entity) {
    reply.code(404);
    return { error: "not_found" };
  }

  return entity;
});
```

### MCP Tools (Zod Schemas)

```typescript
server.tool(
  "create_entities",
  {
    project: z.string().optional(),
    entities: z.array(
      z.object({
        name: z.string().min(1),
        entityType: z.string().min(1),
        observations: z.array(z.string()).default([]),
      })
    ),
  },
  async (input) => {
    const project = resolveProject(input.project);
    const result = graph.createEntities(db, project, input.entities);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);
```

### Database Operations

```typescript
// Prepare statements, use transactions for batch ops
const insertEntity = db.prepare(`
  INSERT INTO entities (project, name, entity_type)
  VALUES (?, ?, ?)
  ON CONFLICT(project, name) DO UPDATE SET
    entity_type = excluded.entity_type
  RETURNING id, name, entity_type
`);

db.transaction(() => {
  for (const e of entities) {
    const row = insertEntity.get(project, e.name, e.entityType) as { ... };
    // ...
  }
})();
```

### Error Handling

```typescript
// Return error objects with HTTP status, don't throw
if (!entity) {
  reply.code(404);
  return { error: "not_found" };
}

// For catch blocks that intentionally ignore errors
} catch {
  // ignore if chmod fails (e.g. Windows)
}

// For async main entry points
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Svelte 5 (Web UI)

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./lib/api";

  // Use $state for reactive state
  let route = $state(window.location.hash || "#/");
  let project = $state(localStorage.getItem("memorantado_project") || "global");
  let projects = $state<string[]>(["global"]);

  // Standard function declarations
  function navigate(hash: string) {
    window.location.hash = hash;
    route = hash;
  }
</script>
```

## Anti-Patterns (DO NOT)

- Never use `as any`, `@ts-ignore`, or `@ts-expect-error`
- Never omit `.js` extension in relative imports
- Never use dynamic SQL string concatenation (use prepared statements)
- Never commit sensitive data (db path resolved at runtime via env/homedir)

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEMORANTADO_PORT` | 3789 | Server port |
| `MEMORANTADO_DB` | `~/.memorantado/memorantado.sqlite` | Database path |

## Quick Reference

- Server runs on `127.0.0.1` only (loopback security)
- MCP endpoint: `/mcp` (session-based, max 3 concurrent)
- REST API: `/api/*` (for web UI)
- Static files: `dist/web/` with SPA fallback
- Project multi-tenancy via `?project=` query param (defaults to "global")
