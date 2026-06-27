export type SuiteName = "locomo" | "longmemeval" | "dmr" | "ama";

export const DATASET_URLS = {
  ama: "https://huggingface.co/datasets/AMA-bench/AMA-bench/resolve/main/test/open_end_qa_set.jsonl",
  dmr: "https://huggingface.co/datasets/MemGPT/MSC-Self-Instruct/resolve/main/msc_self_instruct.jsonl",
  locomo:
    "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  longmemeval:
    "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
} as const;

export const TARGETS: Record<SuiteName, { score: number; label: string }> = {
  ama: { score: 0.5722, label: "AMA-Agent real-world accuracy" },
  dmr: { score: 0.982, label: "Zep DMR reported QA accuracy" },
  locomo: { score: 0.925, label: "Mem0 Platform LoCoMo top-200 QA accuracy" },
  longmemeval: {
    score: 0.944,
    label: "Mem0 Platform LongMemEval top-200 QA accuracy",
  },
};

export const STOPWORDS = new Set(
  "the and that this with from what when where which about into were was are for you your they their his her said".split(
    " "
  )
);
