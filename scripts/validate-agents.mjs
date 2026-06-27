import fs from "node:fs";

const agents = fs.readFileSync("AGENTS.md", "utf8");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

const requiredSections = [
  "Build / Dev / Typecheck",
  "Architecture",
  "Code Style",
  "Environment Variables",
];

for (const section of requiredSections) {
  if (!agents.includes(section)) {
    throw new Error(`AGENTS.md is missing section: ${section}`);
  }
}

const requiredScripts = ["build", "dev", "dev:web", "typecheck", "start"];
for (const script of requiredScripts) {
  if (!pkg.scripts?.[script]) {
    throw new Error(`package.json is missing script required by AGENTS.md: ${script}`);
  }
  if (!agents.includes(`npm run ${script}`) && script !== "start") {
    throw new Error(`AGENTS.md does not document npm run ${script}.`);
  }
}

console.log("AGENTS.md validation passed.");
