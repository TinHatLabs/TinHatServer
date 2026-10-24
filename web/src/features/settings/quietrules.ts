// quietrules.ts — native quietrules.rs: once per login after the first sync, add the 15 missing
// `dev.tinhat.quiet.*` override push rules (no actions) so call/state housekeeping never
// notifies or counts as unread. Append-only: existing rules are never modified. Idempotent.
import { createLogger } from "@/core/log";
import { mx, enc } from "./mx";

const log = createLogger("quietrules");

export const QUIET_RULES: Array<[string, string]> = [
  ["call_member", "org.matrix.msc3401.call.member"],
  ["call_keys", "io.element.call.encryption_keys"],
  ["power_levels", "m.room.power_levels"],
  ["app_state", "dev.tinhat.*"],
  ["space", "m.space.*"],
  ["pinned", "m.room.pinned_events"],
  ["name", "m.room.name"],
  ["topic", "m.room.topic"],
  ["avatar", "m.room.avatar"],
  ["join_rules", "m.room.join_rules"],
  ["history_visibility", "m.room.history_visibility"],
  ["guest_access", "m.room.guest_access"],
  ["encryption", "m.room.encryption"],
  ["canonical_alias", "m.room.canonical_alias"],
  ["redaction", "m.room.redaction"],
];
export const QUIET_PREFIX = "dev.tinhat.quiet.";

export async function ensureQuietRules(): Promise<number> {
  try {
    const r = await mx<{ global?: { override?: Array<{ rule_id: string }> } }>("GET", "/pushrules/");
    const have = new Set((r.global?.override ?? []).map((x) => x.rule_id));
    let added = 0;
    for (const [name, pattern] of QUIET_RULES) {
      const id = QUIET_PREFIX + name;
      if (have.has(id)) continue;
      try {
        await mx("PUT", `/pushrules/global/override/${enc(id)}`, { conditions: [{ kind: "event_match", key: "type", pattern }], actions: [] });
        added++;
      } catch (e) {
        log.warn(`quiet rule ${id} failed`, e);
      }
    }
    log.info(`quiet rules: ${QUIET_RULES.length - added} present, ${added} added`);
    return added;
  } catch (e) {
    log.warn("quiet rules: couldn't read push rules", e);
    return -1;
  }
}
