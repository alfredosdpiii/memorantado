import type { TagFilter, TagMatch } from "./types.js";

const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 256;
const TAG_MATCHES = new Set<TagMatch>(["any", "all", "exact"]);
const REPO_SOURCE = /^repo:\/\/\S+$/;

/** Thrown for caller input the REST layer answers with 400. */
export class InputError extends Error {}

/** Thrown when the target's state forbids the change (answered with 409). */
export class StateError extends Error {}

/**
 * Tags are opaque, case-sensitive labels (for example `ultron:session:<id>`):
 * trimmed, non-empty, without whitespace, unique and sorted, at most 32.
 */
export function normalizeTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new InputError("tags must be an array of strings");
  const unique = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "string") throw new InputError("tags must be strings");
    const trimmed = tag.trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.length > MAX_TAG_LENGTH) {
      throw new InputError(`invalid tag: ${JSON.stringify(tag)}`);
    }
    unique.add(trimmed);
  }
  if (unique.size > MAX_TAGS) throw new InputError(`at most ${MAX_TAGS} tags`);
  return [...unique].sort();
}

/**
 * A filter from request input: `tags` as an array or a comma-separated string,
 * `match` defaulting to "any". No tags means no filter.
 */
export function parseTagFilter(tags: unknown, match: unknown): TagFilter | undefined {
  const list =
    typeof tags === "string"
      ? tags.split(",").filter((tag) => tag.trim())
      : (tags as unknown[] | undefined);
  const normalized = normalizeTags(list);
  if (!normalized.length) return undefined;
  const mode = match ?? "any";
  if (!TAG_MATCHES.has(mode as TagMatch)) {
    throw new InputError('tagsMatch must be "any", "all" or "exact"');
  }
  return { tags: normalized, match: mode as TagMatch };
}

/** The `repo://<path>` source of a file snapshot. */
export function normalizeRepoSource(source: unknown): string {
  if (typeof source !== "string" || !REPO_SOURCE.test(source.trim())) {
    throw new InputError("source must be repo://<path>");
  }
  return source.trim();
}

/** An ISO-8601 instant in the stored `YYYY-MM-DDTHH:MM:SS.sssZ` form. */
export function normalizeInstant(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new InputError(`${name} must be an ISO date`);
  return date.toISOString();
}

type TagTable = { table: "memory_tags" | "episode_tags"; column: string };

export const MEMORY_TAGS: TagTable = { table: "memory_tags", column: "memory_id" };
export const EPISODE_TAGS: TagTable = { table: "episode_tags", column: "episode_id" };

/**
 * A SQL predicate (sqlite and Postgres alike) that holds when the tags of the
 * row `owner` (for example `sm.id`) satisfy `filter`. `param` binds one value
 * and returns its placeholder. "exact" with no tags means untagged.
 */
export function tagPredicate(
  { table, column }: TagTable,
  owner: string,
  filter: TagFilter,
  param: (value: string | number) => string
): string {
  const tagsOf = `FROM ${table} tg WHERE tg.${column} = ${owner}`;
  if (!filter.tags.length) return `NOT EXISTS (SELECT 1 ${tagsOf})`;
  const list = filter.tags.map((tag) => param(tag)).join(", ");
  if (filter.match === "any") {
    return `EXISTS (SELECT 1 ${tagsOf} AND tg.tag IN (${list}))`;
  }
  const matched = `(SELECT count(*) ${tagsOf} AND tg.tag IN (${list})) = ${param(filter.tags.length)}`;
  if (filter.match === "all") return matched;
  return `${matched} AND (SELECT count(*) ${tagsOf}) = ${param(filter.tags.length)}`;
}

/** A `?` binder over `params`, for clauses built in placeholder order. */
export function sqliteBinder(params: Array<string | number>) {
  return (value: string | number) => {
    params.push(value);
    return "?";
  };
}

/** Correlated subqueries that return the row's tags as a JSON array text. */
export function tagsJsonSql(dialect: "sqlite" | "pg", tags: TagTable, owner: string) {
  const { table, column } = tags;
  return dialect === "sqlite"
    ? `(SELECT json_group_array(tg.tag) FROM ${table} tg WHERE tg.${column} = ${owner})`
    : `(SELECT json_agg(tg.tag ORDER BY tg.tag)::text FROM ${table} tg WHERE tg.${column} = ${owner})`;
}

export function parseTagsJson(value: string | null | undefined): string[] {
  return value ? (JSON.parse(value) as string[]).sort() : [];
}
