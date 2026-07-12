#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.MEMORANTADO_PORT ?? 3789);
const HELP = `memorantado

Usage:
  memorantado                         Start the local HTTP server
  memorantado --stdio                 Start the MCP stdio server
  memorantado export-jsonl [project]
  memorantado import-jsonl <project> <file>
  memorantado wiki [project] [vault-root]
  memorantado backfill-embeddings [project]

Defaults:
  project: global
  vault-root: ~/Documents/wiki
`;

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

const command = process.argv[2];

if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(HELP);
} else if (command === "--version" || command === "-v") {
  const { version } = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  process.stdout.write(`${version}\n`);
} else if (
  ["export-jsonl", "import-jsonl", "wiki", "backfill-embeddings"].includes(command)
) {
  const [{ openDb }, { migrate }] = await Promise.all([
    import("../dist/db/db.js"),
    import("../dist/db/migrate.js"),
  ]);
  const db = openDb();
  migrate(db);
  try {
    const project = process.argv[3] || "global";
    if (command === "export-jsonl") {
      const { exportProjectJsonl } = await import("../dist/db/exchange.js");
      process.stdout.write(exportProjectJsonl(db, project));
    } else if (command === "import-jsonl") {
      const file = process.argv[4];
      if (!file) throw new Error("usage: memorantado import-jsonl <project> <file>");
      const { importProjectJsonl } = await import("../dist/db/exchange.js");
      console.log(
        JSON.stringify(importProjectJsonl(db, fs.readFileSync(file, "utf8"), project))
      );
    } else if (command === "wiki") {
      const vaultRoot = process.argv[4] || path.join(os.homedir(), "Documents", "wiki");
      const { buildObsidianWiki } = await import("../dist/wiki/obsidian.js");
      console.log(JSON.stringify(buildObsidianWiki(db, project, vaultRoot)));
    } else {
      const { backfillConfiguredEmbeddings } =
        await import("../dist/memory/embeddingBackfill.js");
      console.log(JSON.stringify(await backfillConfiguredEmbeddings(db, project)));
    }
  } finally {
    db.close();
  }
} else if (process.argv.includes("--stdio")) {
  const { main } = await import("../dist/main.js");
  await main();
} else {
  const inUse = await isPortInUse(PORT);
  if (!inUse) {
    const { main } = await import("../dist/main.js");
    await main();
  } else {
    console.log(`memorantado already running on port ${PORT}`);
  }
}
