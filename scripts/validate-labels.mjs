import fs from "node:fs";

const labels = fs.readFileSync(".github/labels.yml", "utf8");

const requiredGroups = [
  "priority: critical",
  "priority: high",
  "priority: medium",
  "priority: low",
  "type: bug",
  "type: feature",
  "type: chore",
  "area: api",
  "area: web",
  "area: infra",
];

for (const label of requiredGroups) {
  if (!labels.includes(`name: "${label}"`)) {
    throw new Error(`Missing required label: ${label}`);
  }
}

console.log("Label taxonomy validation passed.");
