export type RankedChannel = {
  name: string;
  ids: number[];
};

export type FusedRank = {
  id: number;
  score: number;
  ranks: Record<string, number>;
};

export function reciprocalRankFusion(
  channels: RankedChannel[],
  rankConstant = 60
): FusedRank[] {
  const fused = new Map<number, FusedRank>();
  for (const channel of channels) {
    channel.ids.forEach((id, index) => {
      const rank = index + 1;
      const current = fused.get(id) ?? { id, score: 0, ranks: {} };
      current.score += 1 / (rankConstant + rank);
      current.ranks[channel.name] = rank;
      fused.set(id, current);
    });
  }
  return [...fused.values()].sort(
    (left, right) => right.score - left.score || left.id - right.id
  );
}
