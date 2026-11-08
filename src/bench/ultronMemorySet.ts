/**
 * An Ultron-style memory set: what a coding agent remembers across sessions
 * of two repositories. Memories carry Ultron's scope tags
 * (`ultron:session:<id>`, `ultron:project:<id>`, `ultron:global:<id>`), its
 * metadata (`ultron_type`, `ultron_evidence_class`) and a document key;
 * some are later replaced (same key, new text), invalidated, or quote a
 * repository file that then changes. Queries are turns of one session: they
 * may see that session, its project and the global scope, nothing else.
 */

export const SCOPES = {
  s1: "ultron:session:s1",
  s2: "ultron:session:s2",
  s3: "ultron:session:s3",
  p1: "ultron:project:ultron-rs",
  p2: "ultron:project:webshop",
  g: "ultron:global:bryan",
} as const;

type Scope = keyof typeof SCOPES;

export type SetMemory = {
  key: string;
  scope: Scope;
  type: "procedure" | "convention" | "preference" | "fact" | "pitfall";
  evidence: "hypothesis" | "user_statement" | "tool_evidence" | "verified";
  subject: string;
  content: string;
  /** Repository file the memory quotes (by version label in FILES). */
  file?: { path: string; version: "v1"; quote: string };
};

export const FILES: Record<string, { v1: string; v2: string }> = {
  "repo://crates/cli/src/main.rs": {
    v1: "fn main() {\n    let code = ultron_cli::run(std::env::args());\n    std::process::exit(code);\n}\n",
    v2: "fn main() -> std::process::ExitCode {\n    ultron_cli::run(std::env::args()).into()\n}\n",
  },
  "repo://Cargo.toml": {
    v1: '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
    v2: '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
  },
};

export const MEMORIES: SetMemory[] = [
  // ultron-rs project
  {
    key: "p1-tests",
    scope: "p1",
    type: "procedure",
    evidence: "verified",
    subject: "tests",
    content: "Run the Rust test suite with cargo nextest run --workspace --offline.",
  },
  {
    key: "p1-deps",
    scope: "p1",
    type: "convention",
    evidence: "user_statement",
    subject: "dependencies",
    content: "New crates need approval; pin exact versions and build with --offline.",
  },
  {
    key: "p1-prompt",
    scope: "p1",
    type: "convention",
    evidence: "user_statement",
    subject: "system prompt",
    content: "Never edit runtime_guide.rs or other system prompt text directly.",
  },
  {
    key: "p1-exit",
    scope: "p1",
    type: "fact",
    evidence: "tool_evidence",
    subject: "cli entry point",
    content: "The CLI entry point calls std::process::exit with the run code.",
    file: {
      path: "repo://crates/cli/src/main.rs",
      version: "v1",
      quote: "std::process::exit(code)",
    },
  },
  {
    key: "p1-workspace",
    scope: "p1",
    type: "fact",
    evidence: "tool_evidence",
    subject: "workspace",
    content: "The cargo workspace includes every crate under crates/ with resolver 2.",
    file: { path: "repo://Cargo.toml", version: "v1", quote: 'members = ["crates/*"]' },
  },
  {
    key: "p1-repl",
    scope: "p1",
    type: "fact",
    evidence: "verified",
    subject: "model tools",
    content: "The model's only tool is a persistent Python REPL.",
  },
  {
    key: "p1-journal",
    scope: "p1",
    type: "pitfall",
    evidence: "tool_evidence",
    subject: "session journal",
    content: "Never open a session journal for write while searching sessions.",
  },
  // webshop project
  {
    key: "p2-tests",
    scope: "p2",
    type: "procedure",
    evidence: "verified",
    subject: "tests",
    content: "Run the webshop test suite with pnpm vitest run.",
  },
  {
    key: "p2-deploy",
    scope: "p2",
    type: "procedure",
    evidence: "user_statement",
    subject: "deploy",
    content: "Deploy the webshop by pushing a tag; CI ships it to Fly.",
  },
  {
    key: "p2-db",
    scope: "p2",
    type: "fact",
    evidence: "tool_evidence",
    subject: "database",
    content: "The webshop stores orders in Postgres with Prisma migrations.",
  },
  // global
  {
    key: "g-commits",
    scope: "g",
    type: "preference",
    evidence: "user_statement",
    subject: "commits",
    content: "Bryan commits himself: never commit, stage or stash for him.",
  },
  {
    key: "g-style",
    scope: "g",
    type: "preference",
    evidence: "user_statement",
    subject: "reports",
    content: "Reports lead with findings in threes and avoid filler summaries.",
  },
  {
    key: "g-secrets",
    scope: "g",
    type: "convention",
    evidence: "user_statement",
    subject: "secrets",
    content: "Never print API keys; show at most the first six characters.",
  },
  // sessions
  {
    key: "s1-task",
    scope: "s1",
    type: "fact",
    evidence: "hypothesis",
    subject: "current task",
    content: "This session is wiring the judge seat into the delegation usage ledger.",
  },
  {
    key: "s1-flaky",
    scope: "s1",
    type: "pitfall",
    evidence: "tool_evidence",
    subject: "flaky test",
    content: "The retry_after_date test is flaky under heavy load; rerun it once.",
  },
  {
    key: "s2-task",
    scope: "s2",
    type: "fact",
    evidence: "hypothesis",
    subject: "current task",
    content: "This session is building span search over session journals.",
  },
  {
    key: "s3-task",
    scope: "s3",
    type: "fact",
    evidence: "hypothesis",
    subject: "current task",
    content: "This session is fixing the webshop checkout button.",
  },
];

/** Later corrections: same key, new text (the old text must not be recalled). */
export const REPLACEMENTS: Array<{ key: string; content: string }> = [
  {
    key: "p1-tests",
    content:
      "Run the Rust test suite through the gate script: bash gates.sh <label> runs cargo nextest.",
  },
  {
    key: "p2-deploy",
    content: "Deploy the webshop with the release workflow; tags no longer deploy.",
  },
];

/** Memories retired as wrong. */
export const INVALIDATED = ["p1-journal"];

export type SetQuery = {
  session: "s1" | "s2" | "s3";
  query: string;
  expected: string[];
};

export const QUERIES: SetQuery[] = [
  { session: "s1", query: "how do I run the tests", expected: ["p1-tests"] },
  { session: "s3", query: "how do I run the tests", expected: ["p2-tests"] },
  { session: "s1", query: "can I add a new crate dependency", expected: ["p1-deps"] },
  { session: "s2", query: "edit the system prompt text", expected: ["p1-prompt"] },
  { session: "s3", query: "how do we deploy", expected: ["p2-deploy"] },
  { session: "s1", query: "should I commit my changes", expected: ["g-commits"] },
  { session: "s2", query: "printing API keys in logs", expected: ["g-secrets"] },
  { session: "s1", query: "what is the current task", expected: ["s1-task"] },
  { session: "s2", query: "what is the current task", expected: ["s2-task"] },
  { session: "s1", query: "flaky retry test", expected: ["s1-flaky"] },
  { session: "s1", query: "session journal write", expected: [] },
  { session: "s3", query: "where are orders stored", expected: ["p2-db"] },
];

export const SESSION_PROJECT: Record<SetQuery["session"], "p1" | "p2"> = {
  s1: "p1",
  s2: "p1",
  s3: "p2",
};
