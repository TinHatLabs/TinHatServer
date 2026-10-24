// order.ts — the Call stats "This week" rows' order (WIDGETS-UI.md §5; 2026-09-27: no per-person call time): by
// the number of calls (most first), then the shared people order on the name the row shows (people.ts cmpPeople: the
// ASCII-lowercased name, then the name, then the id, each by code point), so the order gives no time away. The desktop's
// CallStatsWidget.qml friendsByCalls is the same rule. Pure (relative imports: the node unit test loads it).
import { cmpPeople } from "../../../widgets/people";

export function friendsByCalls<T extends { user: string; calls: number }>(friends: readonly T[], nameOf: (user: string) => string): T[] {
  return friends
    .map((f) => ({ f, name: nameOf(f.user) }))
    .sort((a, b) => b.f.calls - a.f.calls || cmpPeople({ id: a.f.user, name: a.name }, { id: b.f.user, name: b.name }))
    .map((x) => x.f);
}
