// serverMove.ts — what the server's /.well-known/matrix/client says about a move ("Move to your own domain", Tin Hat
// Server move.py): on a former name where the server went, on the new address the names it had. The rules:
// core/matrix/moved.ts (parseMove). No sign-in needed: the well-known is public.
import { parseMove, type MoveInfo } from "@/core/matrix/moved";

export async function readMove(hsUrl: string): Promise<MoveInfo> {
  try {
    const r = await fetch(`${hsUrl.replace(/\/+$/, "")}/.well-known/matrix/client`, { cache: "no-store" });
    if (!r.ok) return { movedTo: null, movedFrom: [] };
    return parseMove(await r.json());
  } catch {
    return { movedTo: null, movedFrom: [] };
  }
}
