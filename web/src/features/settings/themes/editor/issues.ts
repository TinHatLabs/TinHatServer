// issues.ts — readability lines in words (THEMES-UI.md §13.5): "‹label› — ‹ratio›:1 on ‹background›, needs ‹need›:1",
// a role by its label, a token as "‹area label›: ‹token label›" (the area from tokens.json). The ratio is floored to one
// decimal (it never claims more contrast than there is), the minimum printed as 4.5 / 3.
import type { ContrastIssue } from "@/theme/editor";
import { ROLE_IDS } from "@/theme/engine";
import { areaLabel, roleLabel, tokenLabel } from "@/theme/labels";
import { tokenArea } from "./tokenInfo";

const ROLES = new Set(ROLE_IDS);

export function colourName(id: string): string {
  if (ROLES.has(id)) return roleLabel(id);
  return `${areaLabel(tokenArea(id))}: ${tokenLabel(id)}`;
}

export const ratioText = (r: number): string => (Math.floor(r * 10) / 10).toFixed(1);
export const needText = (n: number): string => (n === 3 ? "3" : String(n));

export function issueLine(i: ContrastIssue): string {
  return `${colourName(i.fg)} — ${ratioText(i.ratio)}:1 on ${colourName(i.bg)}, needs ${needText(i.need)}:1`;
}
