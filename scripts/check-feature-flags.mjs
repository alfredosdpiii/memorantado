import fs from "node:fs";

const registry = JSON.parse(fs.readFileSync("feature-flags.json", "utf8"));
const source = fs.readFileSync("src/featureFlags.ts", "utf8");
const today = new Date().toISOString().slice(0, 10);

if (!Array.isArray(registry.flags) || registry.flags.length === 0) {
  throw new Error("feature-flags.json must define at least one flag.");
}

for (const flag of registry.flags) {
  for (const key of ["name", "env", "owner", "createdAt", "expiresAt", "description"]) {
    if (!flag[key]) throw new Error(`Feature flag is missing ${key}.`);
  }

  if (!source.includes(flag.name)) {
    throw new Error(`${flag.name} is not referenced in src/featureFlags.ts.`);
  }

  if (flag.expiresAt < today) {
    throw new Error(`${flag.name} expired on ${flag.expiresAt}. Remove or extend it.`);
  }
}

console.log(`Checked ${registry.flags.length} feature flag(s).`);
