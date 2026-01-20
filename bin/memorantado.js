#!/usr/bin/env node
import net from "node:net";

const PORT = Number(process.env.MEMORANTADO_PORT ?? 3789);

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

const STDIO_MODE = process.argv.includes("--stdio");

if (STDIO_MODE) {
  // Stdio mode doesn't need the HTTP port, always run
  await import("../dist/main.js");
} else {
  const inUse = await isPortInUse(PORT);
  if (!inUse) {
    await import("../dist/main.js");
  } else {
    console.log(`memorantado already running on port ${PORT}`);
  }
}
