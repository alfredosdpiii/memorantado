import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const outPath = path.resolve("docs/openapi.json");
const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

const tags = { type: "array", items: { type: "string" }, maxItems: 32 };
const tagsMatch = { type: "string", enum: ["any", "all", "exact"], default: "any" };
const evidence = {
  sourceEpisodeId: { type: "integer", minimum: 1 },
  quote: { type: "string" },
  spanStart: { type: "integer" },
};
const claim = {
  scope: { type: "string", enum: ["user", "agent", "session", "project", "global"] },
  kind: { type: "string" },
  subject: { type: "string" },
  predicate: { type: "string" },
  object: { type: "string" },
  content: { type: "string", minLength: 1 },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  importance: { type: "number", minimum: 0, maximum: 1 },
  validFrom: { type: "string", format: "date-time" },
  validTo: { type: "string", format: "date-time" },
  metadata: { type: "object", additionalProperties: true },
  tags,
};
const tagQuery = {
  tags: { type: "string", description: "Comma-separated tags" },
  tagsMatch,
};

/** Request bodies and query parameters of the scoped-memory endpoints. */
const details = {
  "post /api/episodes": {
    body: {
      session: { type: "string" },
      actor: { type: "string" },
      role: { type: "string" },
      content: { type: "string" },
      source: { type: "string" },
      metadata: { type: "object", additionalProperties: true },
      tags,
      extract: { type: "boolean" },
    },
    required: ["content"],
  },
  "get /api/episodes": { query: tagQuery },
  "get /api/semantic-memories": {
    query: {
      status: { type: "string", enum: ["active", "superseded", "invalidated"] },
      lifecycleStatus: { type: "string", enum: ["active", "archived"] },
      ...tagQuery,
      confirmedBefore: { type: "string", format: "date-time" },
      confirmedAfter: { type: "string", format: "date-time" },
      sort: { type: "string", enum: ["importance", "confirmed"] },
      limit: { type: "integer" },
      offset: { type: "integer" },
    },
  },
  "post /api/semantic-memories": {
    body: { ...claim, key: { type: "string" }, ...evidence },
    required: ["subject", "content"],
  },
  "get /api/semantic-memories/by-key": { query: { key: { type: "string" } } },
  "post /api/semantic-memories/{id}/supersede": {
    body: { ...claim, ...evidence },
    required: ["content"],
  },
  "post /api/semantic-memories/{id}/confirm": { body: evidence },
  "post /api/semantic-memories/{id}/invalidate": { body: { reason: { type: "string" } } },
  "post /api/memory-conflicts": {
    body: {
      memoryId: { type: "integer" },
      conflictingId: { type: "integer" },
      reason: { type: "string" },
    },
    required: ["memoryId", "conflictingId", "reason"],
  },
  "post /api/retrieve-context": {
    body: {
      query: { type: "string" },
      limit: { type: "integer" },
      tokenBudget: { type: "integer" },
      mode: { type: "string", enum: ["current", "as_of", "history", "all"] },
      asOf: { type: "string", format: "date-time" },
      recordedAt: { type: "string", format: "date-time" },
      tags,
      tagsMatch,
    },
    required: ["query"],
  },
  "post /api/file-snapshots": {
    body: {
      source: { type: "string", pattern: "^repo://\\S+$" },
      content: { type: "string" },
      session: { type: "string" },
      tags,
    },
    required: ["source", "content"],
  },
  "post /api/file-snapshots/stale": {
    body: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        items: {
          type: "object",
          properties: {
            source: { type: "string", pattern: "^repo://\\S+$" },
            contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
          required: ["source", "contentHash"],
        },
      },
    },
    required: ["files"],
  },
};

const operations = [
  ["get", "/api/health", "Health check"],
  ["get", "/api/metrics", "Prometheus metrics"],
  ["get", "/api/projects", "List projects"],
  ["get", "/api/search", "Search graph and memory"],
  ["get", "/api/graph", "Read the project graph"],
  ["post", "/api/entity", "Create an entity"],
  ["get", "/api/entity/{name}", "Read an entity"],
  ["post", "/api/entity/{name}/observations", "Add an observation"],
  ["delete", "/api/observation/{id}", "Delete an observation"],
  ["post", "/api/relation", "Create a relation"],
  ["delete", "/api/relation/{id}", "Delete a relation"],
  ["get", "/api/memory-items", "List or search memory items"],
  ["post", "/api/memory-items", "Create a memory item"],
  ["get", "/api/memory-items/{id}", "Read a memory item"],
  ["delete", "/api/memory-items/{id}", "Delete a memory item"],
  ["get", "/api/episodes", "List raw episodes"],
  ["post", "/api/episodes", "Append an episode and optionally extract memories"],
  ["get", "/api/episodes/{id}", "Read an episode"],
  ["post", "/api/episodes/{id}/extract", "Extract semantic memories"],
  [
    "post",
    "/api/semantic-memories/{id}/lifecycle",
    "Archive or restore a semantic memory",
  ],
  ["get", "/api/semantic-memories", "List semantic memories"],
  ["post", "/api/semantic-memories", "Create or reinforce a semantic memory"],
  ["get", "/api/semantic-memories/{id}/explain", "Explain memory provenance"],
  ["get", "/api/semantic-memories/by-key", "Read the current memory of a key"],
  ["get", "/api/semantic-memories/{id}", "Read a semantic memory"],
  ["delete", "/api/semantic-memories/{id}", "Forget a semantic memory"],
  ["post", "/api/semantic-memories/{id}/supersede", "Replace a memory with a new claim"],
  ["post", "/api/semantic-memories/{id}/confirm", "Mark a memory as re-verified"],
  ["post", "/api/semantic-memories/{id}/invalidate", "Retire a memory as wrong"],
  ["post", "/api/memory-conflicts", "Flag two memories as conflicting"],
  ["post", "/api/file-snapshots", "Record a repository file version as evidence"],
  ["post", "/api/file-snapshots/stale", "List memories with outdated file evidence"],
  ["post", "/api/embeddings/backfill", "Backfill configured embeddings"],
  ["post", "/api/retrieve-context", "Retrieve a context pack"],
  ["get", "/api/memory-conflicts", "List memory conflicts"],
  ["get", "/api/exchange/jsonl", "Export versioned memory JSONL"],
  ["post", "/api/exchange/jsonl", "Import versioned memory JSONL"],
  ["post", "/api/wiki/obsidian", "Build the Obsidian wiki projection"],
  ["post", "/api/memory-conflicts/{id}/resolve", "Resolve a memory conflict"],
  ["post", "/api/memory-benchmark", "Run local memory benchmark"],
];

function parametersFor(method, route) {
  const params = [];
  if (route.includes("{name}")) {
    params.push({
      in: "path",
      name: "name",
      required: true,
      schema: { type: "string" },
    });
  }
  if (route.includes("{id}")) {
    params.push({
      in: "path",
      name: "id",
      required: true,
      schema: { type: "integer" },
    });
  }
  if (route !== "/api/health" && route !== "/api/metrics") {
    params.push({
      in: "query",
      name: "project",
      required: false,
      schema: { default: "global", type: "string" },
    });
  }
  for (const [name, schema] of Object.entries(
    details[`${method} ${route}`]?.query ?? {}
  )) {
    params.push({ in: "query", name, required: name === "key", schema });
  }
  return params;
}

function requestBodyFor(method, route) {
  if (method !== "post") return undefined;
  const detail = details[`${method} ${route}`];
  const schema = { type: "object", additionalProperties: true };
  if (detail?.body) {
    schema.properties = {
      project: { type: "string", default: "global" },
      ...detail.body,
    };
    if (detail.required) schema.required = detail.required;
  }
  return {
    content: { "application/json": { schema } },
    required: true,
  };
}

function createOperation(method, route, summary) {
  const operation = {
    summary,
    parameters: parametersFor(method, route),
    responses: {
      200: {
        description: "Successful response",
        content: {
          "application/json": {
            schema: { type: ["array", "object", "string", "boolean", "null"] },
          },
        },
      },
    },
  };
  const requestBody = requestBodyFor(method, route);
  if (requestBody) operation.requestBody = requestBody;
  return operation;
}

const paths = {};
for (const [method, route, summary] of operations) {
  paths[route] ??= {};
  paths[route][method] = createOperation(method, route, summary);
}

const schema = {
  openapi: "3.1.0",
  info: {
    title: "memorantado REST API",
    version: packageJson.version,
    description:
      'Local REST API used by the memorantado web UI and by agent clients (scoped recall, curation, file evidence). Invalid input answers 400 {error: "invalid_input"}; a change the target\'s state forbids answers 409 {error: "conflict"}; a missing target answers 404 {error: "not_found"}.',
  },
  servers: [{ url: "http://127.0.0.1:3789" }],
  paths,
};

const rendered = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  if (current !== rendered) {
    throw new Error("docs/openapi.json is stale. Run npm run docs:openapi.");
  }
  console.log("OpenAPI schema is current.");
} else {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rendered);
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}
