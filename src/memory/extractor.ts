import type { CandidateMemory, Episode, MemoryScope } from "./types.js";

const PREFERENCE_RE =
  /\b(prefer|prefers|like|likes|love|loves|want|wants|need|needs|use|uses|using)\b/i;
const IDENTITY_RE = /\b(is|are|was|were|am)\b/i;
const DECISION_RE = /\b(decided|decision|choose|chose)\b/i;
const OPERATIONAL_NOISE_RE =
  /^(?:completed|implemented|added|updated|fixed|changed|generated|recorded|saved|the (?:full )?(?:validation|build|test|lint|format)|(?:full )?(?:validation|build|tests?|lint|format))(?:\b|:)/i;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8);
}

function isDurableSentence(sentence: string): boolean {
  if (OPERATIONAL_NOISE_RE.test(sentence)) return false;
  return (
    PREFERENCE_RE.test(sentence) ||
    IDENTITY_RE.test(sentence) ||
    DECISION_RE.test(sentence)
  );
}

function inferSubject(episode: Episode, sentence: string): string {
  if (episode.actor?.trim()) return episode.actor.trim();
  const match = sentence.match(/^([A-Z][a-zA-Z0-9_-]{1,40})\b/);
  return match?.[1] ?? episode.project;
}

function inferKind(sentence: string): string {
  if (PREFERENCE_RE.test(sentence)) return "preference";
  if (IDENTITY_RE.test(sentence)) return "fact";
  return "note";
}

function inferPredicate(kind: string, sentence: string): string {
  if (kind === "preference") return "prefers";
  if (DECISION_RE.test(sentence)) return "decided";
  if (IDENTITY_RE.test(sentence)) return "is";
  return "states";
}

export type MemoryExtractor = {
  extract(input: Episode): Promise<CandidateMemory[]>;
};

class LocalRuleExtractor implements MemoryExtractor {
  async extract(episode: Episode): Promise<CandidateMemory[]> {
    return splitSentences(episode.content)
      .filter(isDurableSentence)
      .map((sentence) => {
        const kind = inferKind(sentence);
        return {
          scope: (episode.session ? "session" : "project") as MemoryScope,
          kind,
          subject: inferSubject(episode, sentence),
          predicate: inferPredicate(kind, sentence),
          content: sentence,
          confidence: kind === "note" ? 0.55 : 0.72,
          importance: kind === "preference" ? 0.78 : 0.6,
          metadata: { extractor: "local-rule-v2" },
        };
      });
  }
}

export function createLocalExtractor(): MemoryExtractor {
  return new LocalRuleExtractor();
}
