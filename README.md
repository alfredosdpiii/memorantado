# memorantado

Persistent memory storage for AI agents via [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). SQLite-backed knowledge graph and timeline with full-text search, plus a Svelte web UI for visualization.

## Features

- **Knowledge Graph**: Entities with typed relationships and observations
- **Memory Timeline**: Append-only items with kind, tags, and content
- **Full-Text Search**: FTS5-powered search across all data
- **Multi-Project**: Isolated namespaces via `?project=` parameter
- **Web Dashboard**: Svelte 5 UI for browsing, searching, and editing
- **Local-Only Security**: Binds to 127.0.0.1 with host/origin validation

## Installation

### From npm (recommended)

```bash
# Global install
npm install -g memorantado
memorantado

# Or run directly with npx
npx memorantado
```

### From source

```bash
git clone https://github.com/alfredosdpiii/memorantado.git
cd memorantado
npm install
npm run build
npm start
```

Server runs at `http://127.0.0.1:3789`

## MCP Configuration

Add to your MCP client configuration (e.g., Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "memorantado": {
      "type": "http",
      "url": "http://localhost:3789/mcp"
    }
  }
}
```

For project-specific memory:

```json
{
  "mcpServers": {
    "memorantado": {
      "type": "http",
      "url": "http://localhost:3789/mcp?project=my-project"
    }
  }
}
```

## Architecture

```
                    +------------------+
                    |   MCP Clients    |
                    | (Claude, Cursor) |
                    +--------+---------+
                             |
                             v
+---------------------------+---------------------------+
|                     Fastify Server                    |
|                   http://127.0.0.1:3789               |
+-------+-------------------+-------------------+-------+
        |                   |                   |
        v                   v                   v
   /mcp (MCP)         /api/* (REST)        /* (Static)
        |                   |                   |
        v                   v                   v
+-------+-------------------+-------+   +---------------+
|           SQLite Database         |   |   Svelte UI   |
| - entities, observations          |   | - Search      |
| - relations                       |   | - Graph view  |
| - memory_items                    |   | - Entity view |
| - FTS5 indexes                    |   | - Memory list |
+-----------------------------------+   +---------------+
```

### Data Model

**Knowledge Graph** - Structured entity-relationship storage:

| Table | Purpose |
|-------|---------|
| `entities` | Named nodes with type (e.g., "Claude" / "AI Assistant") |
| `observations` | Facts attached to entities |
| `relations` | Typed edges between entities |

**Memory Timeline** - Append-only event log:

| Table | Purpose |
|-------|---------|
| `memory_items` | Timestamped records with kind, title, content, tags |

Both layers support FTS5 full-text search with Porter stemming.

## MCP Tools

### Knowledge Graph

| Tool | Description |
|------|-------------|
| `create_entities` | Create entities with type and initial observations |
| `create_relations` | Create typed relationships between entities |
| `add_observations` | Append observations to existing entities |
| `delete_entities` | Remove entities and cascade-delete relations/observations |
| `delete_observations` | Remove specific observations from entities |
| `delete_relations` | Remove relationships |
| `read_graph` | Retrieve entire graph (entities + relations) |
| `search_nodes` | Full-text search across entities and observations |
| `open_nodes` | Retrieve specific entities by name |

### Memory Timeline

| Tool | Description |
|------|-------------|
| `append_memory_item` | Add timestamped memory with kind, title, content, tags |
| `search_memory_items` | Full-text search with optional kind filter |
| `get_memory_item` | Retrieve single item by ID |
| `delete_memory_item` | Remove item by ID |

### Tool Parameters

All tools accept an optional `project` parameter for namespace isolation. Defaults to "global".

#### create_entities

```typescript
{
  project?: string,
  entities: Array<{
    name: string,         // Unique identifier
    entityType: string,   // Category (e.g., "person", "concept")
    observations?: string[] // Initial facts
  }>
}
```

#### create_relations

```typescript
{
  project?: string,
  relations: Array<{
    from: string,         // Source entity name
    to: string,           // Target entity name
    relationType: string  // Edge label (e.g., "knows", "contains")
  }>
}
```

#### append_memory_item

```typescript
{
  project?: string,
  kind: string,           // Category (e.g., "note", "decision", "task")
  title?: string,         // Optional title
  content: string,        // Main content
  tags?: string[],        // Optional tags for filtering
  source?: string         // Optional source reference
}
```

## Web UI

Access at `http://127.0.0.1:3789` after starting the server.

| Route | Description |
|-------|-------------|
| **Search** (`#/`) | Global search across entities, observations, and memory items |
| **Graph** (`#/graph`) | Visual graph of all entities and relationships |
| **Entity** (`#/entity/:name`) | Detail view with observations and relations |
| **Memory** (`#/memory`) | Browse and search memory timeline |

Project selector in navbar persists to localStorage.

## REST API

For web UI and programmatic access:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/projects` | GET | List all projects |
| `/api/search?q=&project=` | GET | Unified search |
| `/api/graph?project=` | GET | Full graph data |
| `/api/entity/:name?project=` | GET | Single entity detail |
| `/api/entity` | POST | Create entity |
| `/api/entity/:name/observations` | POST | Add observation |
| `/api/observation/:id` | DELETE | Remove observation |
| `/api/relation` | POST | Create relation |
| `/api/relation/:id` | DELETE | Remove relation |
| `/api/memory-items?project=&q=&kind=` | GET | List/search memory |
| `/api/memory-items` | POST | Create memory item |
| `/api/memory-items/:id?project=` | GET | Get memory item |
| `/api/memory-items/:id?project=` | DELETE | Delete memory item |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MEMORANTADO_PORT` | `3789` | Server port |
| `MEMORANTADO_DB` | `~/.memorantado/memorantado.sqlite` | Database file path |

## Development

```bash
# Watch mode with hot reload
npm run dev

# Web UI only (Vite dev server, proxies API)
npm run dev:web

# Type check without build
npm run typecheck

# Full build
npm run build
```

### Project Structure

```
src/
  main.ts              # Fastify server entry point
  security.ts          # Loopback + host/origin validation
  api/routes.ts        # REST endpoints for web UI
  mcp/
    server.ts          # MCP tool definitions (Zod schemas)
    http.ts            # StreamableHTTPServerTransport
    project.ts         # Project name resolution
    eventStore.ts      # SSE event management
  db/
    db.ts              # SQLite connection
    migrate.ts         # Schema migration
    schema.sql         # DDL + FTS5 + triggers
    graph.ts           # Knowledge graph operations
    timeline.ts        # Memory timeline operations

web/                   # Svelte 5 frontend
  src/
    App.svelte         # Router + project selector
    lib/api.ts         # API client
    routes/            # Page components
```

## Security

- **Loopback only**: Server binds to `127.0.0.1`, rejects non-loopback connections
- **Host validation**: Checks `Host` header against allowed values
- **Origin validation**: API routes validate `Origin` header; MCP endpoint rejects browser origins
- **No external network exposure**: Designed for local-only operation

## Requirements

- Node.js >= 20.0.0
- SQLite3 (bundled via better-sqlite3)

## License

MIT
