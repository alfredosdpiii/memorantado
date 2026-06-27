import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const webDir = path.resolve("dist/web");
const budgets = {
  maxAssetGzipBytes: 150 * 1024,
  totalGzipBytes: 350 * 1024,
};

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

if (!fs.existsSync(webDir)) {
  throw new Error("dist/web is missing. Run npm run build before npm run size.");
}

const assets = walk(webDir).filter((file) => /\.(css|html|js|svg)$/.test(file));
const rows = assets.map((file) => {
  const content = fs.readFileSync(file);
  return {
    gzipBytes: gzipSync(content).byteLength,
    path: path.relative(webDir, file),
    rawBytes: content.byteLength,
  };
});

const totalGzipBytes = rows.reduce((sum, row) => sum + row.gzipBytes, 0);
const largest = rows.reduce((max, row) => (row.gzipBytes > max.gzipBytes ? row : max), {
  gzipBytes: 0,
  path: "",
  rawBytes: 0,
});

console.table(rows);

if (largest.gzipBytes > budgets.maxAssetGzipBytes) {
  throw new Error(
    `${largest.path} is ${largest.gzipBytes} bytes gzipped, above ${budgets.maxAssetGzipBytes}.`
  );
}

if (totalGzipBytes > budgets.totalGzipBytes) {
  throw new Error(
    `Total gzip size is ${totalGzipBytes} bytes, above ${budgets.totalGzipBytes}.`
  );
}

console.log(`Bundle size OK: ${totalGzipBytes} bytes gzipped total.`);
