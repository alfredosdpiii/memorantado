import type { CandidateMemory, SemanticMemory } from "./types.js";

const NON_EXCLUSIVE_PREDICATES = new Set(["states", "notes", "mentions"]);

export function semanticConflictReason(
  existing: SemanticMemory,
  incoming: CandidateMemory
): string | null {
  const predicate = (incoming.predicate ?? "states").trim().toLowerCase();
  if (NON_EXCLUSIVE_PREDICATES.has(predicate)) return null;
  if (existing.subject.trim().toLowerCase() !== incoming.subject.trim().toLowerCase()) {
    return null;
  }
  if (existing.predicate.trim().toLowerCase() !== predicate) return null;
  if (existing.scope !== (incoming.scope ?? "project")) return null;
  if (existing.kind !== (incoming.kind ?? "fact")) return null;

  const existingObject = existing.object?.trim();
  const incomingObject = incoming.object?.trim();
  if (!existingObject || !incomingObject) return null;
  if (existingObject.toLowerCase() === incomingObject.toLowerCase()) return null;
  if (
    !periodsOverlap(
      existing.validFrom,
      existing.validTo,
      incoming.validFrom,
      incoming.validTo
    )
  ) {
    return null;
  }
  return `exclusive claim objects differ: ${JSON.stringify(existingObject)} vs ${JSON.stringify(incomingObject)}`;
}

function periodsOverlap(
  leftFrom?: string | null,
  leftTo?: string | null,
  rightFrom?: string | null,
  rightTo?: string | null
): boolean {
  const leftStart = leftFrom ? Date.parse(leftFrom) : Number.NEGATIVE_INFINITY;
  const leftEnd = leftTo ? Date.parse(leftTo) : Number.POSITIVE_INFINITY;
  const rightStart = rightFrom ? Date.parse(rightFrom) : Number.NEGATIVE_INFINITY;
  const rightEnd = rightTo ? Date.parse(rightTo) : Number.POSITIVE_INFINITY;
  if ([leftStart, leftEnd, rightStart, rightEnd].some(Number.isNaN)) return true;
  return leftStart < rightEnd && rightStart < leftEnd;
}
