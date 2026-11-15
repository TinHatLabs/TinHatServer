// shareStopped.ts — a screen share that ended on its own (the shared window or screen is gone) is never a frozen
// picture: the share stops, the call status says so in these words, and the notice carries one button that opens
// the share picker again. The words are the desktop app's (crates/app call_ctl.rs + qml/AppCore.qml), checked on
// both sides against testvectors/share-stopped/vectors.json (byte-identical in both repos).
export const SHARE_STOPPED_PREFIX = "Your share stopped";
export const SHARE_STOPPED_ACTION = "Share again";
export const SHARE_STOPPED_NOTICE_MS = 12000;
export const SHARE_GONE_STATUS = "Your share stopped: the shared window or screen is gone";
/** D02.2 (12.1.16): after an automatic rejoin of a call that was sharing (a browser capture can't outlive its call; the
 *  notice's Share again is the click it needs). The desktop says this only when it couldn't bring the share back. */
export const SHARE_REJOINED_STATUS = "Your share stopped: the call reconnected";

/** D02.7 (12.1.16): the others in the call are told when someone's share ends — after a short wait, and only if that
 *  person is still in the call (a leave has its own cue). The desktop's call_ctl viewer_share_ended_status. */
export const SHARE_VIEWER_ENDED = "{name} stopped sharing their screen";
export const SHARE_VIEWER_GRACE_MS = 800;
export function viewerShareEnded(name: string, stillInCall: boolean, recorder: boolean, sharingAgain = false): string {
  // sharingAgain: a new share of theirs is up already (a quality change re-publishes it) — nothing ended
  if (!stillInCall || recorder || sharingAgain) return "";
  return SHARE_VIEWER_ENDED.replace("{name}", name);
}

/** Is this call status a share that ended on its own (the notice gets the "Share again" button)? */
export const isShareStopped = (status: string): boolean => status.indexOf(SHARE_STOPPED_PREFIX) === 0;

/** The notice for such a status: how long it stays, and its one button (`again` opens the share picker). */
export const shareStoppedNotice = (again: () => void) => ({ timeoutMs: SHARE_STOPPED_NOTICE_MS, action: { label: SHARE_STOPPED_ACTION, run: again } });
