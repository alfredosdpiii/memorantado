import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";

export default defineConfig({
  plugins: [svelte()],
  root: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "../dist/web"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3789",
      "/mcp": "http://127.0.0.1:3789",
    },
  },
});
