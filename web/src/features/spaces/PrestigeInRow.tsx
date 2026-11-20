// PrestigeInRow.tsx — the prestige token placed before a name inside a flex row that already has its own CSS `gap`
// (chat name row, tiles, rows): the token keeps the spec's 4 px to the name whatever the row's gap is (§3.1).
// Rank 0 renders nothing, so the row is exactly what it was. (PrestigeFor = the same for rows without a gap.)
import { PrestigeToken, TOKEN_GAP, TOKEN_SIZE } from "@/features/prestige/PrestigeToken";
import { usePrestige } from "@/features/prestige/store";

export function PrestigeInRow(p: { mxid: string | null | undefined; roomId?: string | null; rowGap: number; size?: number }) {
  const rank = usePrestige(p.mxid, p.roomId);
  if (rank <= 0) return null;
  return (
    <span style={{ display: "inline-flex", flex: "none", alignItems: "center", alignSelf: "center", marginRight: TOKEN_GAP - p.rowGap }}>
      <PrestigeToken rank={rank} mxid={p.mxid ?? undefined} size={p.size ?? TOKEN_SIZE} />
    </span>
  );
}
