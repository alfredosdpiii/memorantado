# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm run build          # Build web UI + TypeScript + copy schema
npm run dev            # Build web, then watch/run server with tsx
npm run dev:web        # Run Vite dev server for web UI only (proxies to :3789)
npm run typecheck      # TypeScript check without emit
npm run start          # Run compiled dist/main.js
```

## Architecture Overview

memorantado is an MCP (Model Context Protocol) server for persistent memory storage with a SQLite backend and Svelte web UI.

### Two-Layer Data Model

1. **Knowledge Graph** (`src/db/graph.ts`): Entities with observations and typed relations between them
   - Entities: Named items with a type and list of observation strings
   - Relations: Directed edges with a relation type
   - Full-text search via FTS5 on entities and observations

2. **Memory Timeline** (`src/db/timeline.ts`): Append-only memory items
   - Items have: kind, optional title, content, tags, source
   - FTS5 search on kind/title/content

### Server Stack

- **Fastify** serves everything on port 3789 (configurable via `MEMORANTADO_PORT`)
- `/mcp` - MCP protocol endpoint using StreamableHTTPServerTransport, session-based with max 3 concurrent sessions
- `/api/*` - REST API for the web UI (`src/api/routes.ts`)
- Static files served from `dist/web` with SPA fallback

### MCP Tools (src/mcp/server.ts)

Graph operations: `create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_observations`, `delete_relations`, `read_graph`, `search_nodes`, `open_nodes`

Timeline operations: `append_memory_item`, `search_memory_items`, `get_memory_item`, `delete_memory_item`

All tools accept optional `project` parameter (defaults to "global") for multi-tenancy.

### Database

- SQLite via better-sqlite3, stored at `~/.memorantado/memorantado.sqlite` (or `MEMORANTADO_DB`)
- Schema: `src/db/schema.sql` - includes FTS5 tables and triggers for sync
- Migrations run on startup via `src/db/migrate.ts`

### Web UI (Svelte 5)

- `web/src/App.svelte` - Router and project selector
- Routes: Search (`#/`), Graph (`#/graph`), Entity detail (`#/entity/:name`), Memory items (`#/memory`)
- Uses hash-based routing with `localStorage` for project persistence
