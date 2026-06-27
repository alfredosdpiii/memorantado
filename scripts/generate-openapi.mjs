import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const outPath = path.resolve("docs/openapi.json");

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
  ["get", "/api/semantic-memories", "List semantic memories"],
  ["post", "/api/semantic-memories", "Create or reinforce a semantic memory"],
  ["get", "/api/semantic-memories/{id}/explain", "Explain memory provenance"],
  ["post", "/api/retrieve-context", "Retrieve a context pack"],
  ["get", "/api/memory-conflicts", "List memory conflicts"],
  ["post", "/api/memory-conflicts/{id}/resolve", "Resolve a memory conflict"],
  ["post", "/api/memory-benchmark", "Run local memory benchmark"],
];

function parametersFor(route) {
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
  return params;
}

function requestBodyFor(method) {
  if (method !== "post") return undefined;
  return {
    content: {
      "application/json": {
        schema: { type: "object", additionalProperties: true },
      },
    },
    required: true,
  };
}

function createOperation(method, route, summary) {
  const operation = {
    summary,
    parameters: parametersFor(route),
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
  const requestBody = requestBodyFor(method);
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
    version: "0.1.7",
    description: "Local REST API used by the memorantado web UI.",
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
